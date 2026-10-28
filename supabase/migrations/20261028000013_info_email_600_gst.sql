-- The info sales email quotes ongoing management at $600/month + GST, the
-- standard fee since 24 Oct (it still said $690/month).
update public.sales_email_templates
   set body = replace(body, 'optional starting at $690/month.', 'optional starting at $600/month + GST.'),
       updated_at = now()
 where kind = 'info' and body like '%$690/month%';
