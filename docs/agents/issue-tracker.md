# Issue tracker: GitHub

Issues and planning artifacts live at `anthonykewl20/kogg`.
Use the `gh` CLI with `--repo anthonykewl20/kogg`; do not infer the tracker
from the current Git remote.

## Conventions

- Create: `gh issue create --repo anthonykewl20/kogg`
- Read: `gh issue view <number> --repo anthonykewl20/kogg --comments`
- List: `gh issue list --repo anthonykewl20/kogg`
- Comment: `gh issue comment <number> --repo anthonykewl20/kogg`
- Label/edit: `gh issue edit <number> --repo anthonykewl20/kogg`
- Close: `gh issue close <number> --repo anthonykewl20/kogg`

## Pull requests as a triage surface

PRs as a request surface: no.

## Publishing and fetching

When a skill says “publish to the issue tracker,” create an issue in
`anthonykewl20/kogg`. When it says “fetch the relevant ticket,” read it there.

## Wayfinding operations

- Map: issue labelled `wayfinder:map`.
- Child tickets: GitHub sub-issues, falling back to task-list links only if
  native sub-issues are unavailable.
- Ticket labels: `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- Blocking: native GitHub issue dependencies, falling back to a
  `Blocked by:` body line only if dependencies are unavailable.
- Claim: assign the ticket before beginning work.
- Resolve: add a resolution comment, close the ticket, then append its linked
  gist to the map’s Decisions-so-far section.
