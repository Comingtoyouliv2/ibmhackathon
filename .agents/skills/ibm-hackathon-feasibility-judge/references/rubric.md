# Feasibility rubric — 20 points

| Dimension | Max | Full-credit evidence |
|---|---:|---|
| MVP scope and completion | 4 | The smallest valuable flow is complete, coherent, and demoable. |
| Architecture and dependency realism | 4 | Critical services, models, APIs, limits, failure modes, and costs are known and credible. |
| Deployment and operations | 4 | Reproducible setup/deployment, observability, bounded runtime, and fallback are demonstrated. |
| Security, privacy, and governance | 3 | Credentials and source data are protected; untrusted code/model behavior is contained; provenance is auditable. |
| Adoption, integration, and maintenance | 3 | Fits existing work systems and has an owner/update path after the event. |
| Delivery plan and risk control | 2 | Remaining work is prioritized with explicit cut lines and mitigations. |

Apply the lowest relevant cap:

- Core demo cannot be run or viewed: 10/20.
- Critical path depends on unimplemented external integration: 13/20.
- No credible deployment or adoption path: 15/20.
- Critical cost, privacy, or platform constraints ignored: 14/20.

Score “works locally with setup” separately from “could operate for a team.”
