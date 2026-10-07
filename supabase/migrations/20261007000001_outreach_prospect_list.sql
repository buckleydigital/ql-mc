-- Cold outreach: the dashboard's Prospects tab.
--
-- prospects is closed to the browser (service role only, migration
-- 20261006000001); this is the one read the dashboard gets, operators only,
-- filtered and paged on the server so the tab stays fast at tens of thousands
-- of rows. Read-only: prospects are found, verified and queued by Jarvis, and
-- a person's say-so goes in through the do-not-contact list, not by editing
-- rows here.

create or replace function public.prospect_list(
  p_niche  text default null,
  p_status text default null,
  p_search text default null,
  p_limit  int  default 50,
  p_offset int  default 0
)
returns table (
  id uuid, niche_key text, business_name text, website text, email text, email_source_url text,
  contact_name text, contact_role text, phone text, suburb text, state text, status text,
  status_reason text, email_verdict text, fit_score numeric, opener text, source text,
  found_at timestamptz, contacted_at timestamptz, total bigint
)
language plpgsql stable security definer set search_path = public as $$
declare
  q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform public.jarvis_assert_operator();
  return query
    select p.id, p.niche_key, p.business_name, p.website, p.email, p.email_source_url,
           p.contact_name, p.contact_role, p.phone, p.suburb, p.state, p.status,
           p.status_reason, p.email_verdict, p.fit_score, p.opener, p.source,
           p.found_at, p.contacted_at, count(*) over () as total
      from public.prospects p
     where (p_niche  is null or p.niche_key = p_niche)
       and (p_status is null or p.status = p_status)
       and (q is null
            or p.business_name ilike '%' || q || '%'
            or p.email         ilike '%' || q || '%'
            or p.domain        ilike '%' || q || '%'
            or p.suburb        ilike '%' || q || '%')
     order by p.found_at desc, p.id
     limit  least(greatest(coalesce(p_limit, 50), 1), 200)
     offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.prospect_list(text, text, text, int, int) from public, anon;
grant execute on function public.prospect_list(text, text, text, int, int) to authenticated;
