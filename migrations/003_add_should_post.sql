-- Migration: 003_add_should_post
-- Adds a should_post column to availability_logs to track whether a status update
-- was intended to be announced in #availability.
--
-- Default is TRUE so that all pre-existing rows (which always posted) are treated
-- correctly when a subsequent /availability clear looks up the last log entry.

ALTER TABLE public.availability_logs
  ADD COLUMN should_post boolean NOT NULL DEFAULT true;
