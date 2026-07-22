# Jackson Databind #5715 × #6075

This is a live, clean-merge semantic-conflict candidate captured at immutable
commit SHAs. It is deliberately **not** added to the existing frozen benchmark.
Promotion still requires human causal approval through the benchmark-promotion
workflow.

The interaction is a lifecycle-completion gap. PR #6075 changes one-Map
`@JsonAnySetter` handling to accumulate values and invokes `_finishAnySetter`
from existing deserialization exits. PR #5715 adds `deserializeWithWrapped`,
which uses the same any-setter state but returns the bean without that completion
step.

With the declared companion `jackson-annotations` PR installed, the original
A+B tree failed the targeted cross-feature test three consecutive times with
`expected: <1> but was: <0>`. Changing only the new wrapped exit to return
`_finishAnySetter(ctxt, bean)` made the test pass. Existing A, B, and union test
suites also passed (53, 34, and 87 tests respectively).
