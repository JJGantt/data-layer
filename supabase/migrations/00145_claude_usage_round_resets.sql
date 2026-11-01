-- The usage endpoint and the SDK stream report the same reset moment with different sub-second jitter
-- (18:59:59.63 on one call, 19:00:00.68 on the next), which made every reading look new to the repeat
-- filter. Resets fall on the hour, so both are rounded to the nearest minute before the comparison.
create or replace function public.claude_usage_skip_repeat() returns trigger
language plpgsql as $$
declare
  last public.claude_usage;
begin
  new.five_hour_resets_at := date_trunc('minute', new.five_hour_resets_at + interval '30 seconds');
  new.seven_day_resets_at := date_trunc('minute', new.seven_day_resets_at + interval '30 seconds');
  new.five_hour_pct := round(new.five_hour_pct, 1);
  new.seven_day_pct := round(new.seven_day_pct, 1);
  select * into last from public.claude_usage order by observed_at desc, id desc limit 1;
  if found
     and last.five_hour_pct = new.five_hour_pct
     and last.seven_day_pct = new.seven_day_pct
     and last.five_hour_resets_at is not distinct from new.five_hour_resets_at
     and last.seven_day_resets_at is not distinct from new.seven_day_resets_at
     and coalesce(last.status, '') = coalesce(new.status, coalesce(last.status, '')) then
    return null;
  end if;
  return new;
end $$;

update public.claude_usage set
  five_hour_resets_at = date_trunc('minute', five_hour_resets_at + interval '30 seconds'),
  seven_day_resets_at = date_trunc('minute', seven_day_resets_at + interval '30 seconds');
