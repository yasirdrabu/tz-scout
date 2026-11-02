-- Workspaces set up before Nurture existed: the tier value map gains it (HubSpot Buying tier option "Nurture").
UPDATE "crm"."field_mapping" SET "transform_config" = "transform_config" || '{"nurture":"Nurture"}'::jsonb WHERE "scout_field" = 'tier' AND "transform" = 'enum_map' AND "transform_config" IS NOT NULL AND NOT ("transform_config" ? 'nurture');
