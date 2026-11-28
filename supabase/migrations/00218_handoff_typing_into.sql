-- Where his typing will go on a handoff's screen, read with each screenshot (README § Handoffs): the field
-- that has the keyboard focus, as {label, secure, x, y, w, h} with the rectangle in fractions of full_image.
-- The phone outlines it and names it on the Type button, so a tap that moved the focus is visible before
-- anything is typed.
alter table public.handoffs add column if not exists typing_into jsonb;
