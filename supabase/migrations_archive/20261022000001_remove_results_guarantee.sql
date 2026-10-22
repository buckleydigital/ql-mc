-- The 10 quoted jobs guarantee is withdrawn (quoteleads-terms Section 5 is now
-- "No Results Guarantee"). Strip every promise of it from the copy that still
-- goes out: the two offer emails and the solar cold-outreach offer.
--
-- Each replace covers both the seeded wording and the admin-edited wording, so
-- this is safe on a fresh database and on prod. A no-op once applied.

update public.sales_email_templates
   set body = replace(
              replace(
              replace(body,
                E'Our guarantee: a minimum of 10 quotes in the first 30 days, or we''ll refund the entire build fee.\n\n', ''),
                E'\n  - 10 quoted jobs in your first 30 days, or your build fee back', ''),
                E'Results guarantee: if you don''t see results in the first 30 days, you don''t pay. Details: https://quoteleads.com.au/quoteleads-terms\n\n', ''),
       updated_at = now()
 where body ilike '%guarantee%' or body ilike '%build fee back%';

update public.outreach_niches
   set offer = replace(offer, ' with no lock-in, and we guarantee quoted jobs.', ' with no lock-in.'),
       updated_at = now()
 where offer like '%we guarantee quoted jobs%';
