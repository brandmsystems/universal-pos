-- Removes the keys 0059 added from every plan version. Keys a Super Admin set
-- on a later version go too: with this migration rolled back nothing reads
-- them, and a version carrying them is indistinguishable from one 0059 wrote.
--
-- The entitlement documents 0059 appended are LEFT. A document is a record of
-- what was published, and a rollback must not destroy a record of something
-- that happened (see 0042). The extra keys in them are read by nothing once
-- the gates are gone.
UPDATE platform.plan_version
   SET limits   = limits - 'devices',
       features = features - 'recipes' - 'suppliers' - 'purchasing'
                           - 'reports_advanced' - 'reports_full';
