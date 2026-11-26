-- Puts `staff_admin` back as 0075 stated it (Basic false, every other plan
-- true). The platform key is not restored here: the catalogue seed owns the
-- platform permission rows, and the code being rolled back to seeds it. The
-- entitlement documents and outbox messages 0076 appended are left (0042, 0059).
UPDATE platform.plan_version pv
   SET features = pv.features || jsonb_build_object('staff_admin', p.key <> 'basic')
  FROM platform.plan p
 WHERE p.id = pv.plan_id AND NOT pv.features ? 'staff_admin';
