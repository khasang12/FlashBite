-- Runs once on first init of an empty Postgres data dir (docker-entrypoint-initdb.d).
-- Creates the payments bounded-context database alongside flashbite_write.
CREATE DATABASE flashbite_payments;
