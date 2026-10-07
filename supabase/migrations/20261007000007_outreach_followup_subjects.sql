-- Follow-ups go in the same thread: only the first email of a sequence needs
-- a subject. A blank subject on a later step makes Instantly send it as a
-- reply to the first, which reads like a person following up.
create or replace function public.outreach_sequence_save(p_key text, p_steps jsonb, p_approve boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare s jsonb; n int; i int := 0;
begin
  perform public.jarvis_assert_operator();
  if jsonb_typeof(p_steps) <> 'array' then raise exception 'Steps must be a list' using errcode = '22023'; end if;
  n := jsonb_array_length(p_steps);
  if n < 1 or n > 4 then raise exception 'A sequence has 1 to 4 emails' using errcode = '22023'; end if;
  for s in select * from jsonb_array_elements(p_steps) loop
    i := i + 1;
    if i = 1 and coalesce(btrim(s->>'subject'), '') = '' then
      raise exception 'The first email needs a subject' using errcode = '22023';
    end if;
    if coalesce(btrim(s->>'body'), '') = '' then
      raise exception 'Every email needs a body' using errcode = '22023';
    end if;
    if coalesce((s->>'delay_days')::int, 0) not between 0 and 30 then
      raise exception 'Waits are 0 to 30 days' using errcode = '22023';
    end if;
  end loop;
  update public.outreach_niches
     set sequence = p_steps,
         sequence_approved_at = case when p_approve then now() else null end,
         updated_at = now()
   where key = p_key;
  if not found then raise exception 'No niche %', p_key using errcode = '22023'; end if;
end;
$$;
