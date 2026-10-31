-- Mark the starter Vehicle component's VIN and licence plate as identifiers, so
-- two Vehicle objects with the same VIN or plate are recognised as one.
update field_def f set options = f.options || '{"identifier": true}'::jsonb
from component_def c
where c.id = f.component_id and c.key = 'vehicle' and f.key in ('vin', 'plate') and f.type = 'text';
