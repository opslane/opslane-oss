-- projects.default_branch was NOT NULL DEFAULT 'main', which cannot express
-- "we have not learned this repo's default branch yet". Onboarding Phase 1
-- creates projects before GitHub is connected, so the guess was written as
-- fact and later used to `git clone --branch main`, breaking every repo whose
-- default branch is not 'main' (issue #180).
--
-- NULL now means unknown. Existing rows keep their current value on purpose:
-- they are corrected when the GitHub App installation lands, or on the next
-- successful clone. Blanking them here would strip a usable value out from
-- under jobs that are mid-flight.
ALTER TABLE projects
  ALTER COLUMN default_branch DROP NOT NULL,
  ALTER COLUMN default_branch DROP DEFAULT;
