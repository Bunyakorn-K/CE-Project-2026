# API

## Tests run one file at a time

`pnpm test` passes `--fileParallelism=false`. Every test file opens the same SQLite
file (`data/laundrytwin.sqlite`), so two files running at once can observe each
other's rows: a global count, a purge, or a budget total picks up a neighbouring
test's fixtures and passes or fails depending on timing. Serial is 14s for the whole
package — cheaper than chasing an intermittent red build.
