-- Cold outreach stage 3: qualify and personalise.
--
-- After a run has found and verified prospects, outreach-qualify reads each
-- verified prospect's website and asks Claude for a fit score (0-10), a
-- one-line reason, and an opening line written for that business. 6 and up
-- becomes 'qualified' (ready for review); below that, 'rejected' with the
-- reason. The reason is kept in status_reason either way, so the Prospects
-- tab shows why. The run log gains what this step did and what it cost.

alter table public.outreach_runs add column if not exists qualified   int            not null default 0;
alter table public.outreach_runs add column if not exists not_fit     int            not null default 0;
alter table public.outreach_runs add column if not exists ai_cost_usd numeric(10, 4) not null default 0;
