-- The Spam Act asks for accurate details of how to contact the sender, not a
-- postal address (that is the US rule). outreach_settings.postal_address now
-- holds those contact details - ABN, phone or website - and the sign-off name
-- is optional: emails sign as the business when it is blank.
comment on column public.outreach_settings.postal_address is
  'Contact details shown in every email footer: ABN, phone or website (Spam Act s17). Named before it was widened.';
comment on column public.outreach_settings.sender_name is
  'Optional sign-off name for {sender}; the business name is used when blank.';

-- The sign-off name can be cleared again, now that it is optional.
create or replace function public.outreach_settings_update(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.jarvis_assert_operator();
  update public.outreach_settings set
    sender_name      = case when p ? 'sender_name' then nullif(btrim(p->>'sender_name'), '') else sender_name end,
    business_name    = coalesce(nullif(btrim(p->>'business_name'), ''), business_name),
    postal_address   = coalesce(nullif(btrim(p->>'postal_address'), ''), postal_address),
    sending_accounts = case when p ? 'sending_accounts'
                            then coalesce((select array_agg(lower(btrim(x))) from jsonb_array_elements_text(p->'sending_accounts') x where btrim(x) <> ''), '{}')
                            else sending_accounts end,
    send_from        = coalesce(nullif(p->>'send_from', ''), send_from),
    send_to          = coalesce(nullif(p->>'send_to', ''), send_to),
    timezone         = coalesce(nullif(p->>'timezone', ''), timezone),
    daily_limit      = coalesce((p->>'daily_limit')::int, daily_limit),
    updated_at       = now()
  where id = 1;
end;
$$;
