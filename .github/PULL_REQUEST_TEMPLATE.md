<!--
  PlanSync PR template.

  Three things matter for the closes refs to actually trigger
  GitHub's auto-close on merge:

    1. Use the `Closes` heading + bullet list below (or paste
       `closes #N` lines somewhere in this body — anywhere in the
       body works). NEVER rely on commit messages alone — this
       repo squash-merges, and squash drops per-commit messages.
    2. Plain `closes #123`, NOT `**closes #123**` (markdown bold
       can break GitHub's regex).
    3. One ref per line is the safest format if you have many.

  Recognised keywords (case-insensitive, all equivalent):
    close / closes / closed
    fix   / fixes  / fixed
    resolve / resolves / resolved

  See docs/AGENT_WORKFLOW_NOTES.md for why this template exists
  and what went wrong before it was added.
-->

## Closes

<!-- One `closes #N` per line. Delete this section if the PR is
     not tied to any issue. Keep the heading exactly as `## Closes`
     so reviewers can grep for it. -->

- closes #ISSUE_NUMBER

## Summary

<!-- One paragraph: what changed and why. Link to a longer design
     doc / RFC if there is one. -->

## Test plan

<!-- Commands a reviewer can run locally to verify. e.g.

       bash scripts/lint.sh
       cd packages/api && vitest tests/integration/foo.test.ts

     If you added new tests, list the file paths. -->

## Risk

<!-- One line. Examples:
       Low — adds a new column with a default; no read paths changed.
       Medium — changes the FSM transition table; covered by 27 unit tests.
       High — touches the auth path; manual e2e verification done.
-->
