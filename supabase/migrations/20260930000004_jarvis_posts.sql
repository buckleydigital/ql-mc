-- Jarvis drafts social posts; you approve them and post them yourself.
--
-- Deliberately NOT connected to Facebook, Instagram or any other account.
-- Nothing here can publish anywhere: a post ends as an image and a caption you
-- copy, and "posted" is a box you tick.
--
-- Every draft passes an editor first (jarvis-content, a second model with a
-- strict rubric and the facts each claim rests on) and only drafts that pass
-- are saved. Edits you make before approving are kept alongside what he
-- wrote, so the next draft is written from how you actually talk.

create table if not exists public.jarvis_posts (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  caption          text        not null check (length(caption) between 1 and 2200),
  -- What he wrote, kept once you edit it: the before/after pairs are how he
  -- learns the voice.
  original_caption text,
  -- facebook, instagram, linkedin - where it is meant for; informational only.
  platforms        text[]      not null default '{facebook,instagram}',
  -- The card's content, kept so the image can be re-rendered after an edit.
  card             jsonb,
  -- Every figure or claim in the post and where it came from. The editor
  -- rejects a number that is not in here.
  facts            jsonb       not null default '[]'::jsonb,
  image_url        text,
  editor_score     numeric(3, 1),
  editor_notes     text,
  status           text        not null default 'draft'
                   check (status in ('draft', 'approved', 'posted', 'rejected')),
  approved_at      timestamptz,
  posted_at        timestamptz,
  -- panel, sms, job: where he was when he drafted it.
  source           text
);

create index if not exists jarvis_posts_created_idx on public.jarvis_posts (created_at desc);

alter table public.jarvis_posts enable row level security;
alter table public.jarvis_posts force  row level security;
revoke all on table public.jarvis_posts from public, anon, authenticated;
grant all  on table public.jarvis_posts to service_role;

-- The rendered cards. Public so an image can be opened and saved from a phone
-- by its link; these are made to be posted publicly anyway, and each name is
-- an unguessable UUID. Only the service role writes here.
insert into storage.buckets (id, name, public)
values ('jarvis-content', 'jarvis-content', true)
on conflict (id) do update set public = true;

-- Who the posts are for and how they should sound. Read by the drafting model
-- and by the editor; blank means the built-in default in jarvis-content.
alter table public.business_settings
  add column if not exists jarvis_content_brief text;

-- ── The panel's Posts screen ───────────────────────────────────────────────

create or replace function public.jarvis_post_list(p_limit int default 40)
returns table (id uuid, created_at timestamptz, caption text, original_caption text,
               platforms text[], card jsonb, facts jsonb, image_url text,
               editor_score numeric, editor_notes text, status text,
               approved_at timestamptz, posted_at timestamptz, source text)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.jarvis_assert_operator();
  return query
    select p.id, p.created_at, p.caption, p.original_caption, p.platforms, p.card, p.facts,
           p.image_url, p.editor_score, p.editor_notes, p.status, p.approved_at, p.posted_at, p.source
      from public.jarvis_posts p
     where p.status <> 'rejected'
     order by (p.status = 'draft') desc, (p.status = 'approved') desc, p.created_at desc
     limit least(greatest(coalesce(p_limit, 40), 1), 200);
end;
$$;

-- Approve, optionally with your own wording. The first edit keeps his original
-- so the difference can be learned from.
create or replace function public.jarvis_post_approve(p_id uuid, p_caption text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v text := btrim(coalesce(p_caption, ''));
begin
  perform public.jarvis_assert_operator();
  if v <> '' and length(v) > 2200 then
    raise exception 'A caption is at most 2200 characters.' using errcode = '22023';
  end if;
  update public.jarvis_posts p
     set original_caption = case when v <> '' and v <> p.caption
                                 then coalesce(p.original_caption, p.caption)
                                 else p.original_caption end,
         caption     = case when v <> '' then v else p.caption end,
         status      = 'approved',
         approved_at = now(),
         updated_at  = now()
   where p.id = p_id and p.status in ('draft', 'approved');
end;
$$;

create or replace function public.jarvis_post_set_status(p_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform public.jarvis_assert_operator();
  if p_status not in ('posted', 'rejected', 'approved') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  update public.jarvis_posts
     set status = p_status,
         posted_at = case when p_status = 'posted' then now() else posted_at end,
         updated_at = now()
   where id = p_id;
end;
$$;

revoke all on function public.jarvis_post_list(int)                 from public, anon;
revoke all on function public.jarvis_post_approve(uuid, text)       from public, anon;
revoke all on function public.jarvis_post_set_status(uuid, text)    from public, anon;
grant execute on function public.jarvis_post_list(int)                 to authenticated;
grant execute on function public.jarvis_post_approve(uuid, text)       to authenticated;
grant execute on function public.jarvis_post_set_status(uuid, text)    to authenticated;
