-- Pay per lead: the Solar + Battery lead type is now solar_and_battery (was
-- solar_battery), matching ql-hq and what the lead forms send.
update public.clients
   set active_niches = array_replace(active_niches, 'solar_battery', 'solar_and_battery'),
       updated_at = now()
 where 'solar_battery' = any(active_niches);
