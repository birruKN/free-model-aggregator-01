# free-model-aggregator-01

[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/birruKN/free-model-aggregator-01/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/birruKN/free-model-aggregator-01/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)

A deterministic free-model aggregator. One Node server speaks both the OpenAI Chat Completions and Anthropic Messages wires (JSON and SSE), registers its catalog with the trial environment, and routes each of the 20 requests to the best free model that meets its requirements — tools, images, JSON mode, system prompts, budgets, refusals and failover included. Routing is planned globally rather than greedily: every candidate call is priced as refusal-risk × price + weighted rating loss, the plan is kept only while banked plus planned loss stays under a hard cap, and the whole plan is repriced after every outcome. That holds the quality ceiling (99 on all three practice trials) while spending fewer provider calls than a rating-first router — 23/23/25 calls against 25/25/26 — because in this competition, calls are the tie-break. State exports are byte-identical across repeated runs.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=4zccysyp&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01) · AI agents build software for cash rewards</sub>
