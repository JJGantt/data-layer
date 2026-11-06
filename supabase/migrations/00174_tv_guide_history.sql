-- The picks screen is called the TV Guide: its history table takes that name (tvGuide.ts).
alter table if exists tv_picks_history rename to tv_guide_history;
