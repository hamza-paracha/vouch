# Measure Jev review quality

Proof-Jev is an open-source project using Jev for structured review. A fast response is useful only if the judgments help. This suite makes review errors measurable and reproducible.

## Run without a provider

From the source checkout or the full installed package:

```sh
npm run review:eval
npm run review:eval -- --responses evals/review/recorded-jev-1.13.0.json
```

The first command validates the eight fixtures and reports no quality score or model calls. The second replays recorded **real Jev responses** and calculates their scores without contacting the provider. Simulation-based unit tests verify the scorer separately; they are not presented as model performance.

The initial public set has four regressions and four corresponding clean controls: removing a public export, removing external-input validation, dropping an explicitly required error fallback, and breaking a documented return contract. Executable tests demonstrate the labelled behavior. Labels and grading explanations are withheld from model state; Jev receives both source versions through the production question builder and answers all eight production questions. Only the explicitly labelled binary questions are scored.

## Run a new live evaluation

Configure the same explicit provider and persistent budget variables as [structured review](structured-review.md#configuration), then run:

```sh
npm run review:eval -- --live
```

The CLI does not automatically load `.env`. Each fixture consumes one request; the suite needs eight available reservations. It never increases a budget, clears a ledger, retries a failed response, or sends private project source. Oversized fixtures fail validation before any calls. An eight-second provider timeout and 45-second overall deadline bound a live run.

Each run writes owner-only `report.json` and, for live/replay runs, `responses.json` under `out/review-evaluation/<run-id>/`. `--output <directory>` changes that root. Save the response file to replay later. A hash binds recordings to exact fixtures **and production questions**; changing either invalidates old recordings rather than silently comparing different experiments.

Exit 0 means a dry run validated or every case returned a valid response, **not** that the model was accurate. Exit 1 means incomplete evaluation; exit 2 means invalid input/configuration. Use the measured metrics and a chosen acceptance policy for a quality gate.

## Read the scores

- **Coverage:** scored labels divided by expected labels. Always inspect it first. Missing, failed, cancelled, and budget-limited cases stay visible.
- **Accuracy at 0.5:** correctness of the yes/no choice before confidence thresholds.
- **Actionable precision/recall:** a positive counts as detected only when it meets the configured medium threshold (0.70 by default). An uncertain positive is a miss, not a detection. Precision is unknown when nothing is flagged.
- **False-positive rate:** clean controls incorrectly flagged as actionable concerns. “Negative” in this table means no actionable positive, including abstention; it is not a safety judgment.
- **Uncertainty:** labels whose selected outcome falls below the medium threshold.
- **Brier score:** mean squared error of the yes probability against the binary label; lower is better.
- **Confidence bins:** sample count, mean selected probability, and observed accuracy. Tiny bins do not establish calibration. These descriptive bin boundaries remain 0.50/0.70/0.90 even if operational thresholds change.

Metrics use observed labels only. An incomplete run can have excellent scores and poor coverage. Reports retain both; dry runs return null quality scores. Live usage records token counts and reserved estimates. Unknown response usage remains unknown; reservations are not provider invoices. Replay token counts describe the original responses while calls and new reservations remain zero.

## Recorded baseline

The checked-in `recorded-jev-1.13.0.json` came from eight live requests on September 26, 2026. All eight labelled judgments matched: four actionable detections, zero false alarms, zero missed positives, and zero uncertain labelled answers. Brier score: **0.01645**. Input tokens: **8,058**; output tokens: **1,479**. Other unlabelled questions may still be uncertain; the eight correct labels do not mean eight entirely clean review reports.

[Machine-readable baseline](review-quality-baseline.json) includes each label, probability, runtime, thresholds, and limitations. The original integration measurement remains separately documented in [review-validation.json](review-validation.json).

This is a small, public, JavaScript-only synthetic suite with explicit contracts and full before/after context. It is not held-out evidence, a representative repository benchmark, a security certification, or proof that confidence is calibrated. Future work should add independently labelled real changes, ambiguous evidence, multiple languages, and adversarial source comments. Do not tune prompts on these eight cases and then describe their scores as independent validation.
