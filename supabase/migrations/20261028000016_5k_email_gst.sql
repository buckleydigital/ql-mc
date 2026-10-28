-- The 5K offer email quotes ongoing management as $1,200/month + GST.
update public.sales_email_templates
   set body = replace(body, 'optional at $1,200/month.', 'optional at $1,200/month + GST.'), updated_at = now()
 where kind = 'info_5k' and body like '%$1,200/month.%';
update public.sales_email_template_niches
   set body = replace(body, 'optional at $1,200/month.', 'optional at $1,200/month + GST.'), updated_at = now()
 where kind = 'info_5k' and body like '%$1,200/month.%';
