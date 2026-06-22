-- Make users.id a text PK so drivers can be seeded with stable ids (drv-1..drv-4) where the
-- JWT sub equals the dispatch driverId. Existing UUID values cast to their text representation.
ALTER TABLE "users" ALTER COLUMN "id" SET DATA TYPE TEXT USING "id"::text;
