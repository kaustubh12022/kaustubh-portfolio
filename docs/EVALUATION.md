# Evaluation

How good is the conversational portfolio, really? This document is the
measurement, not the intention.

Everything below was measured on **21 October 2026** against the live Neon
index and the live `/api/chat` route. The numbers are the output of the two
scripts in `scripts/eval/`, and every command needed to reproduce them is
written down.

---

## 1. What is measured, and with what

There are three layers, and they are deliberately separated because they fail
for different reasons.

| Layer | Script | Model called? | What it answers |
|---|---|---|---|
| **Retrieval** | `scripts/eval/retrieval-eval.ts` | no (embedding only) | Does the hybrid retriever put the right source chunk in the top k? |
| **Answer** | `scripts/eval/golden-eval.ts` | yes (150 LLM calls) | Does the whole pipeline answer correctly, cite correctly and refuse correctly? |
| **Asset** | `tests/eval/golden-set.test.ts`, `tests/eval/metrics.test.ts` | no | Is the golden set itself still valid, and are the metric functions correct? |

The golden set lives in `evals/golden-set.yaml`: **150 questions** in nine
buckets.

| Bucket | n | What it is about |
|---|---|---|
| `code_explanation` | 30 | "How does X work?" - the answer has to name the mechanism and cite the code |
| `file_lookup` | 20 | "Which file/function does X?" - the answer has to name a path and a symbol |
| `architecture` | 15 | "How is X put together?" |
| `data_model` | 10 | "What does the schema look like?" |
| `metrics` | 15 | "What numbers can you prove?" - answered from `content/metrics.yaml` |
| `claim_correction` | 25 | "Your resume says X. Prove it." - the answer has to contradict the claim and reproduce the approved public wording |
| `comparison` | 10 | "How do X and Y differ?" |
| `off_topic_refusal` | 15 | "What is the weather?" - the answer has to refuse |
| `adversarial_prompt_injection` | 10 | injection attempts that try to make the assistant confirm a contradicted capability or leak the system prompt |

The 25 `claim_correction` questions cover every claim the brief calls out:
`java-spring`, `medflow`, `c54-socketio`, `smartapply-weasyprint`,
`pawna-name` (the CampFlow naming), `campflow-owners`,
`campflow-multitenant`, `campflow-microservices`, `personal-ai-os-stack`,
`rag-vector` and `neon-pulse`. `tests/eval/golden-set.test.ts` asserts that
each of them is exercised.

---

## 2. The metric definitions

`lib/eval/metrics.ts` is a pure module: no database, no embeddings, no I/O.
`tests/eval/metrics.test.ts` checks it against hand-computed numbers.

**Relevance.** A retrieved chunk satisfies an expectation when it is the same
file **and** its line range overlaps the expected range. Overlap, not
equality: the indexer chunks by AST, so a chunk is usually a superset of the
function body. When an expectation names a symbol but no line range, the hit
has to be in the same file and carry the same symbol.

**The expected range is the WHOLE function.** The chunker splits a long
function across several chunks: `handleGeminiLiveRelay` is eight chunks
covering lines 64-631, `score_jobs` is four chunks covering 333-586. The
relevant passage for "where is X implemented" is the whole function, so
`scripts/eval/fix-golden-ranges.ts` rewrites every expected range to the union
of that symbol's chunks, straight out of the live index. Without this the
measurement is wrong by construction: every other chunk of the same function
would count as a miss. The fix moved overall recall@5 from 27.8% to 34.8%.

| Metric | Definition |
|---|---|
| `recall@k` | fraction of the expected ranges that were retrieved in the top k |
| `hitRate@k` | 1 when at least one expected range was retrieved in the top k, else 0 |
| `precision@k` | fraction of the top k that was relevant |
| `MRR@k` | `1 / rank` of the first relevant hit, 0 when there is none |
| `nDCG@k` | `DCG@k / IDCG@k`, gain is binary, discount is `1/log2(rank+1)` |

**What a question counts against.** The 79 questions that name source files are
scored by the retrieval benchmark. The other 71 (metrics, claims, comparisons,
refusals) are answered from the content layer and the claim ledger; they have
no code target, so they are excluded from the retrieval numbers and scored by
the answer benchmark instead.

---

## 3. How to run it

```bash
# the dev server has to be up for the answer benchmark
npm run dev

# 3. the retrieval benchmark (no LLM, no cost)
#    `lib/retrieval/db.ts` carries `import "server-only"`, so the CLI runs with
#    the react-server condition
NODE_OPTIONS=--conditions=react-server npx tsx scripts/eval/retrieval-eval.ts
NODE_OPTIONS=--conditions=react-server npx tsx scripts/eval/retrieval-eval.ts --questions=q001,q002
NODE_OPTIONS=--conditions=react-server npx tsx scripts/eval/retrieval-eval.ts --json --out=report.json

# 4. the answer benchmark (150 LLM calls, about $0.15)
npx tsx scripts/eval/golden-eval.ts
npx tsx scripts/eval/golden-eval.ts --bucket=claim_correction --per-bucket=10
npx tsx scripts/eval/golden-eval.ts --questions=q091,q095 --json --out=report.json

# 5. promptfoo (needs a grader key)
npx promptfoo eval -c evals/promptfoo.yaml

# 7. the fast, LLM-free tests
npx vitest run
```

The answer benchmark sends a different `x-forwarded-for` per request. The route
rate limits to 10 requests per 5 minutes per IP (`lib/ai/ratelimit.ts`), which
is explicitly documented as a courtesy limit, not a security boundary. This
only applies to the local benchmark against the local dev server.

---

## 4. Retrieval results

**Thresholds: recall@5 >= 0.85, MRR@10 >= 0.75.**

<!--RETRIEVAL-RESULTS-->

Measured **2026-10-21T12:48:09.059Z** against the live Neon index (79 scorable questions, 71 answered from the content layer and not scored here).

### Overall

| metric | value | threshold | verdict |
|---|---|---|---|
| recall@5 | **34.8%** | 85.0% | **FAIL** |
| recall@10 | 44.9% | - | - |
| MRR@10 | **26.0%** | 75.0% | **FAIL** |
| nDCG@10 | 38.3% | - | - |
| hit-rate@10 | 57.0% | - | - |
| precision@10 | 9.1% | - | - |

**RESULT: FAIL.** The retrieval benchmark does not meet its thresholds. The numbers are reported as measured; no threshold was relaxed.

### The diagnostics that explain the failure

The chunk-level metric above is the strict one. Two looser views say where the loss is:

| view | recall@5 | recall@10 | MRR@10 | hit@10 |
|---|---|---|---|---|
| chunk level (the metric) | 34.8% | 44.9% | 26.0% | 57.0% |
| FILE level (line ranges ignored) | 64.6% | 75.9% | - | - |
| tests removed from the pool | 39.9% | 44.9% | 30.2% | 57.0% |
| tests removed, 40 candidate pool | 39.9% | 48.7% | 30.6% | 59.5% |

Reading: the retriever finds the right FILE in about two thirds of the questions (64.6% at k=5) but the right CHUNK much less often (34.8% at k=5). The gap between the two rows is the whole problem.

### Per bucket

| bucket | n | recall@5 | recall@10 | MRR@10 | nDCG@10 | hit-rate@10 |
|---|---|---|---|---|---|---|
| architecture | 15 | 16.7% | 23.3% | 18.3% | 20.2% | 46.7% |
| code_explanation | 30 | 31.7% | 40.0% | 28.3% | 34.3% | 56.7% |
| comparison | 4 | 12.5% | 12.5% | 6.3% | 6.6% | 25.0% |
| data_model | 10 | 50.0% | 65.0% | 40.0% | 76.0% | 70.0% |
| file_lookup | 20 | 50.0% | 65.0% | 25.3% | 45.3% | 65.0% |

### Per project

| project | n | recall@5 | recall@10 | MRR@10 | nDCG@10 | hit-rate@10 |
|---|---|---|---|---|---|---|
| (none) | 3 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| aura | 11 | 36.4% | 45.5% | 29.5% | 51.2% | 72.7% |
| pawna | 19 | 39.5% | 44.7% | 31.1% | 38.2% | 57.9% |
| personal-ai-os | 8 | 25.0% | 37.5% | 20.5% | 51.7% | 37.5% |
| smartapply | 38 | 36.8% | 50.0% | 25.7% | 34.8% | 60.5% |

### The 10 worst questions

| id | bucket | recall@5 | MRR@10 | hit@10 | top hit | wanted |
|---|---|---|---|---|---|---|
| q001 | code_explanation | 0.0% | 0.000 | 0 | `src/resume_tailor.py:84-150` | `src/scorer.py:136-155`, `src/scorer.py:159-210` |
| q004 | code_explanation | 0.0% | 0.000 | 0 | `tests/conftest.py:157-167` | `src/ai_engine.py:214-246` |
| q006 | code_explanation | 0.0% | 0.000 | 0 | `src/prompts/tailoring_prompt.txt:31-70` | `src/resume_tailor.py:326-404`, `src/resume_tailor.py:445-460` |
| q007 | code_explanation | 0.0% | 0.000 | 0 | `src/prompts/scoring_prompt.txt:31-43` | `src/resume_tailor.py:407-442` |
| q008 | code_explanation | 0.0% | 0.000 | 0 | `src/prompts/tailoring_prompt.txt:1-40` | `src/resume_tailor.py:280-323` |
| q010 | code_explanation | 0.0% | 0.000 | 0 | `src/consultancy_veto.py:119-124` | `src/consultancy_veto.py:76-107`, `src/consultancy_veto.py:110-116` |
| q015 | code_explanation | 0.0% | 0.000 | 0 | `tests/test_m5_ats_pdf.py:131-151` | `ats_verifier.py:19-145` |
| q016 | code_explanation | 0.0% | 0.000 | 0 | `backend/controllers/dashboardController.js:1-3` | `backend/controllers/bookingController.js:65-111` |
| q017 | code_explanation | 0.0% | 0.000 | 0 | `backend/routes/bookingRoutes.js:64-76` | `backend/controllers/bookingController.js:120-298`, `backend/models/BlockedDate.js:1-28` |
| q019 | code_explanation | 0.0% | 0.000 | 0 | `backend/models/User.js:76-79` | `backend/controllers/authController.js:14-51`, `backend/controllers/authController.js:91-129` |

### The per-question detail

Every question, its metrics and its top three hits:

**q001** (code_explanation) - How does SmartApply decide which job postings are worth sending to the LLM?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `src/resume_tailor.py:84-150` - fused score 0.03126
2. `tests/test_m5_ats_pdf.py:40-49` (sample_job_qa) - fused score 0.02904
3. `tests/test_m5_ats_pdf.py:53-62` (sample_job_java) - fused score 0.02533

**q002** (code_explanation) - How does SmartApply strip HR boilerplate out of a job description before it costs tokens?

recall@5 100.0% | recall@10 100.0% | MRR@10 1.000 | nDCG@10 1.000 | first chunk rank 1 | first file rank 1

1. `src/scorer.py:122-133` (strip_boilerplate) - fused score 0.03279
2. `src/scraper.py:456-459` (fetch_linkedin_description) - fused score 0.02862
3. `tests/e2e/test_tier2_boundary_negative.py:330-340` (test_f6_b1_empty_boilerplate_description) - fused score 0.02789

**q003** (code_explanation) - How does SmartApply compute the DeepSeek cost of a scoring call?

recall@5 100.0% | recall@10 100.0% | MRR@10 1.000 | nDCG@10 1.000 | first chunk rank 1 | first file rank 1

1. `src/ai_engine.py:59-74` (calculate_deepseek_cost) - fused score 0.03202
2. `tests/test_ai_engine_multiprovider.py:44-58` (test_live_deepseek_scoring) - fused score 0.03154
3. `tests/test_m3_scoring_telemetry.py:293-311` (test_m3_calculate_deepseek_cost_chat_and_reasoner) - fused score 0.02976

**q004** (code_explanation) - How does SmartApply turn a DeepSeek response into structured scoring data?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 6

1. `tests/conftest.py:157-167` (mock_deepseek_scoring_response) - fused score 0.03252
2. `tests/test_ai_engine_multiprovider.py:44-58` (test_live_deepseek_scoring) - fused score 0.03178
3. `tests/e2e/test_tier1_feature_coverage.py:372-385` (test_f5_2_micro_json_response_parsing) - fused score 0.02921

**q005** (code_explanation) - How does SmartApply make sure the tailored resume never invents a skill?

recall@5 50.0% | recall@10 50.0% | MRR@10 0.333 | nDCG@10 0.307 | first chunk rank 3 | first file rank 1

1. `src/resume_tailor.py:878-893` (tailor_resume_deterministic) - fused score 0.03202
2. `src/resume_tailor.py:896-902` (tailor_resume) - fused score 0.03062
3. `src/resume_tailor.py:463-542` (validate_and_sanitize_tailored) - fused score 0.02976

**q006** (code_explanation) - How does SmartApply pick which projects to put on a tailored resume?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 2

1. `src/prompts/tailoring_prompt.txt:31-70` - fused score 0.03021
2. `src/resume_tailor.py:84-150` - fused score 0.02854
3. `tests/conftest.py:36-43` (master_resume) - fused score 0.02712

**q007** (code_explanation) - How does SmartApply check that a job description's requirements are actually covered by the resume?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 8

1. `src/prompts/scoring_prompt.txt:31-43` - fused score 0.03202
2. `tests/conftest.py:36-43` (master_resume) - fused score 0.02753
3. `tests/test_m4_challenger1_gen2_stress.py:22-42` (master_resume) - fused score 0.02585

**q008** (code_explanation) - What role lens does SmartApply apply when it tailors a resume for a Java backend job?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 7

1. `src/prompts/tailoring_prompt.txt:1-40` - fused score 0.03178
2. `tests/test_m4_tailoring_guardrails.py:386-398` (test_m4_project_role_weighted_reordering) - fused score 0.02986
3. `src/prompts/tailoring_prompt.txt:31-70` - fused score 0.02932

**q009** (code_explanation) - How does SmartApply filter out consultancy and repost spam?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.500 | nDCG@10 0.693 | first chunk rank 2 | first file rank 1

1. `src/consultancy_veto.py:4-12` - fused score 0.03154
2. `src/consultancy_veto.py:243-276` (deduplicate_and_veto_reposts) - fused score 0.03055
3. `src/consultancy_veto.py:127-160` (is_consultancy_or_spam) - fused score 0.03002

**q010** (code_explanation) - How does SmartApply decide that a posting is a repost of a job it already saw?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 1

1. `src/consultancy_veto.py:119-124` (compute_description_hash) - fused score 0.02889
2. `tests/test_m1_challenger2_boundaries.py:76-89` (_make_job) - fused score 0.02862
3. `src/consultancy_veto.py:4-12` - fused score 0.02776

**q011** (code_explanation) - How does SmartApply decide that a job has too many applicants and should be applied to early?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.250 | nDCG@10 0.764 | first chunk rank 4 | first file rank 2

1. `tests/test_boost_system.py:96-110` (test_pillar1_applicant_count_extraction) - fused score 0.03252
2. `src/early_applicant.py:206-242` (filter_early_applicants) - fused score 0.03200
3. `tests/test_boost_system.py:131-141` (test_pillar1_evaluate_and_filter_early_applicants) - fused score 0.02963

**q012** (code_explanation) - How does the SmartApply tracker persist a job and its score into the database?

recall@5 0.0% | recall@10 50.0% | MRR@10 0.111 | nDCG@10 0.185 | first chunk rank 9 | first file rank 1

1. `src/tracker.py:4-10` - fused score 0.02802
2. `src/tracker.py:160-167` (batch_upsert_jobs) - fused score 0.02773
3. `tests/test_boost_system.py:4-10` - fused score 0.02753

**q013** (code_explanation) - How does SmartApply cache a job description score so it does not pay for the same job twice?

recall@5 0.0% | recall@10 50.0% | MRR@10 0.167 | nDCG@10 0.218 | first chunk rank 6 | first file rank 6

1. `tests/test_m3_scoring_telemetry.py:255-286` (test_m3_url_normalization_prevents_cache_miss) - fused score 0.03202
2. `src/scorer.py:413-492` (score_jobs) - fused score 0.02986
3. `tests/test_m3_challenger2_adversarial.py:155-208` (test_adversarial_token_accounting_10_scored_2_shortlisted) - fused score 0.02720

**q014** (code_explanation) - How does the SmartApply pipeline actually run end to end, from the Flask entry point?

recall@5 50.0% | recall@10 50.0% | MRR@10 0.200 | nDCG@10 0.237 | first chunk rank 5 | first file rank 1

1. `app.py:621-630` (stop_pipeline) - fused score 0.03252
2. `tests/e2e/test_tier1_feature_coverage.py:787-796` (test_f11_1_api_status_endpoint) - fused score 0.03012
3. `tests/e2e/test_tier3_pairwise_combinations.py:292-303` (test_tier3_f11_f1_ui_trigger_handles_pipeline_stop_and_error) - fused score 0.02901

**q015** (code_explanation) - How does SmartApply verify that the PDF it produced is readable by an ATS?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `tests/test_m5_ats_pdf.py:131-151` (test_pdf_generation_single_page) - fused score 0.03048
2. `tests/test_boost_system.py:213-219` (test_pillar3_desktop_resume_ats_compliance) - fused score 0.03009
3. `tests/test_boost_system.py:386-395` (test_pillar4_pdf_resume_loading_and_extraction) - fused score 0.02904

**q016** (code_explanation) - How does the Pawna booking controller work out the total price of a booking?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 4

1. `backend/controllers/dashboardController.js:1-3` (Booking) - fused score 0.02840
2. `backend/tests/m1_controller_integration.test.js:93-111` (finalPricePublic) - fused score 0.02648
3. `backend/controllers/analyticsController.js:64-67` - fused score 0.02586

**q017** (code_explanation) - How does Pawna stop two guests from booking the same campsite on the same dates?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 6

1. `backend/routes/bookingRoutes.js:64-76` (rows) - fused score 0.02912
2. `backend/routes/bookingRoutes.js:58-63` (bookings) - fused score 0.02591
3. `backend/models/Booking.js:84-97` (bookingSchema) - fused score 0.02408

**q018** (code_explanation) - How does Pawna keep an owner from seeing or editing another owner's properties?

recall@5 50.0% | recall@10 50.0% | MRR@10 0.200 | nDCG@10 0.237 | first chunk rank 5 | first file rank 1

1. `backend/controllers/ownerController.js:158-161` - fused score 0.02859
2. `backend/routes/bookingRoutes.js:52-56` - fused score 0.02654
3. `backend/controllers/propertyController.js:247-265` (getPropertyById) - fused score 0.02652

**q019** (code_explanation) - How does Pawna authenticate a user and store their password?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 5

1. `backend/models/User.js:76-79` - fused score 0.03128
2. `backend/models/User.js:66-71` - fused score 0.02927
3. `backend/controllers/ownerController.js:28-31` (buildTemporaryPasswordPayload) - fused score 0.02905

**q020** (code_explanation) - How does Pawna handle image uploads for a property?

recall@5 50.0% | recall@10 50.0% | MRR@10 1.000 | nDCG@10 0.613 | first chunk rank 1 | first file rank 1

1. `backend/controllers/uploadController.js:34-42` (uploadImage) - fused score 0.03068
2. `src/components/manager/ImageUploader.jsx:5-84` (ImageUploader) - fused score 0.02920
3. `backend/controllers/uploadController.js:18-30` (streamUpload) - fused score 0.02896

**q021** (code_explanation) - How does Pawna generate a unique URL slug for a new property?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.500 | nDCG@10 0.631 | first chunk rank 2 | first file rank 1

1. `backend/utils/slugify.js:1-19` (Property) - fused score 0.03178
2. `backend/utils/slugify.js:29-48` (generateUniqueSlug) - fused score 0.03151
3. `backend/utils/slugify.js:21-28` - fused score 0.03068

**q022** (code_explanation) - How does the Personal AI OS chat edge function route a message without wasting tokens?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 2

1. `lib/features/chat/data/chat_repository.g.dart:180-185` (ChatMessagesProvider.) - fused score 0.03151
2. `supabase/functions/chat/index.ts:300-306` (messages) - fused score 0.03128
3. `lib/features/chat/data/chat_repository.dart:102-107` (chatSessions) - fused score 0.03037

**q023** (code_explanation) - What happens in the Personal AI OS edge function when Gemini is unavailable?

recall@5 0.0% | recall@10 100.0% | MRR@10 0.143 | nDCG@10 0.333 | first chunk rank 7 | first file rank 1

1. `supabase/functions/chat/index.ts:169-175` (GEMINI_API_KEY) - fused score 0.03279
2. `supabase/functions/chat/.npmrc:1-3` - fused score 0.03151
3. `supabase/functions/chat/index.ts:378-399` - fused score 0.03151

**q024** (code_explanation) - How does Aura convert browser microphone audio into the format the Gemini Live API expects?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 9

1. `src/audio/audioRecorder.js:49-128` (AudioRecorder.start) - fused score 0.03175
2. `src/audio/audioRecorder.js:1-11` - fused score 0.03054
3. `server/geminiLiveRelay.js:1-8` - fused score 0.02947

**q025** (code_explanation) - How does Aura handle the caller interrupting the voice agent mid-sentence?

recall@5 50.0% | recall@10 50.0% | MRR@10 0.500 | nDCG@10 0.387 | first chunk rank 2 | first file rank 2

1. `src/hooks/useVoiceAgent.js:385-415` (VoiceAgentCoordinator.handleError) - fused score 0.03178
2. `server/transcriptManager.js:104-110` (TranscriptManager.handleInterruption) - fused score 0.03110
3. `src/hooks/useVoiceAgent.js:329-346` (VoiceAgentCoordinator.handleSocketMessage) - fused score 0.02939

**q026** (code_explanation) - How does Aura decide that a caller's request is out of scope for the skincare brand?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 1

1. `server/brandPolicy.js:12-41` (BRAND_POLICIES) - fused score 0.03202
2. `server/brandPolicy.js:1-10` - fused score 0.03200
3. `server/brandPolicy.js:292-297` - fused score 0.03178

**q027** (code_explanation) - How does Aura produce a call summary when the model call fails?

recall@5 50.0% | recall@10 50.0% | MRR@10 1.000 | nDCG@10 1.000 | first chunk rank 1 | first file rank 1

1. `server/summarizer.js:304-310` (generateCallSummary) - fused score 0.03151
2. `server/summarizer.js:224-303` (generateCallSummary) - fused score 0.03009
3. `server/geminiLiveRelay.js:464-543` (handleGeminiLiveRelay) - fused score 0.02939

**q028** (code_explanation) - How does the Aura server relay the browser WebSocket session to the Gemini Live API?

recall@5 50.0% | recall@10 50.0% | MRR@10 0.500 | nDCG@10 1.142 | first chunk rank 2 | first file rank 2

1. `server/server.js:9-19` - fused score 0.03178
2. `server/geminiLiveRelay.js:624-631` (handleGeminiLiveRelay) - fused score 0.03080
3. `server/geminiLiveRelay.js:144-223` (handleGeminiLiveRelay) - fused score 0.03078

**q029** (code_explanation) - How does the SmartApply batch URL pipeline turn a pasted list of job links into scored jobs?

recall@5 100.0% | recall@10 100.0% | MRR@10 1.000 | nDCG@10 1.368 | first chunk rank 1 | first file rank 1

1. `src/batch_url_pipeline.py:557-636` (run_batch_url_pipeline) - fused score 0.03105
2. `src/batch_url_pipeline.py:4-12` - fused score 0.02983
3. `src/batch_url_pipeline.py:182-261` (parse_job_from_url) - fused score 0.02639

**q030** (code_explanation) - How does SmartApply generate the morning digest of applications to send?

recall@5 0.0% | recall@10 50.0% | MRR@10 0.100 | nDCG@10 0.177 | first chunk rank 10 | first file rank 1

1. `src/morning_digest.py:4-16` - fused score 0.03178
2. `src/morning_digest.py:18-29` - fused score 0.03021
3. `tests/test_boost_system.py:257-269` (test_pillar5_morning_digest_generation) - fused score 0.03016

**q031** (file_lookup) - Which file and function computes the DeepSeek token cost for SmartApply?

recall@5 100.0% | recall@10 100.0% | MRR@10 1.000 | nDCG@10 1.000 | first chunk rank 1 | first file rank 1

1. `src/ai_engine.py:59-74` (calculate_deepseek_cost) - fused score 0.03227
2. `tests/test_ai_engine_multiprovider.py:33-41` (test_deepseek_cost_calculation) - fused score 0.03128
3. `tests/e2e/test_tier1_feature_coverage.py:490-508` (test_f6_5_token_cost_calculation) - fused score 0.03080

**q032** (file_lookup) - Where is the job relevance filter for SmartApply implemented - give me the file and the function name.

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `tests/e2e/test_tier1_feature_coverage.py:465-471` (test_f6_3_zero_token_keyword_relevance_check) - fused score 0.03041
2. `src/resume_tailor.py:84-150` - fused score 0.02879
3. `src/prompts/tailoring_prompt.txt:1-40` - fused score 0.02665

**q033** (file_lookup) - Which file renders the SmartApply resume PDF, and what function do I look at?

recall@5 0.0% | recall@10 100.0% | MRR@10 0.100 | nDCG@10 0.289 | first chunk rank 10 | first file rank 1

1. `src/pdf_generator.py:94-139` (generate_resume_pdf) - fused score 0.03202
2. `tests/test_m5_ats_pdf.py:1-20` - fused score 0.03089
3. `tests/test_m5_ats_pdf.py:131-151` (test_pdf_generation_single_page) - fused score 0.03078

**q034** (file_lookup) - Where is the ATS audit of the generated resume PDF written?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.250 | nDCG@10 0.431 | first chunk rank 4 | first file rank 2

1. `src/pdf_generator.py:94-139` (generate_resume_pdf) - fused score 0.03150
2. `ats_verifier.py:153-160` - fused score 0.03048
3. `tests/test_boost_system.py:213-219` (test_pillar3_desktop_resume_ats_compliance) - fused score 0.02983

**q035** (file_lookup) - Which file contains the resume tailoring logic that locks personal facts?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.200 | nDCG@10 0.387 | first chunk rank 5 | first file rank 4

1. `src/config_loader.py:26-34` (load_resume) - fused score 0.03080
2. `tests/conftest.py:36-43` (master_resume) - fused score 0.02921
3. `tests/test_m4_challenger1_gen2_stress.py:22-42` (master_resume) - fused score 0.02858

**q036** (file_lookup) - Which function in SmartApply applies the pandas based job filtering?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.500 | nDCG@10 1.418 | first chunk rank 2 | first file rank 2

1. `src/scorer.py:325-328` (apply_pandas_filter) - fused score 0.03227
2. `src/scraper.py:220-299` (apply_pandas_filter) - fused score 0.03089
3. `tests/test_m1_challenger2_boundaries.py:76-89` (_make_job) - fused score 0.02590

**q037** (file_lookup) - Where is the SmartApply job model defined?

recall@5 0.0% | recall@10 100.0% | MRR@10 0.111 | nDCG@10 0.301 | first chunk rank 9 | first file rank 9

1. `tests/test_m5_ats_pdf.py:40-49` (sample_job_qa) - fused score 0.02798
2. `tests/test_m5_ats_pdf.py:53-62` (sample_job_java) - fused score 0.02604
3. `tests/e2e/test_tier4_workload_scenarios.py:16-19` - fused score 0.02338

**q038** (file_lookup) - Which file holds the consultancy and repost veto logic in SmartApply?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.500 | nDCG@10 0.631 | first chunk rank 2 | first file rank 1

1. `src/consultancy_veto.py:4-12` - fused score 0.03202
2. `src/consultancy_veto.py:127-160` (is_consultancy_or_spam) - fused score 0.03101
3. `src/consultancy_veto.py:46-53` - fused score 0.03002

**q039** (file_lookup) - Which file contains the early applicant tier logic in SmartApply?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.200 | nDCG@10 0.688 | first chunk rank 5 | first file rank 2

1. `tests/test_boost_system.py:96-110` (test_pillar1_applicant_count_extraction) - fused score 0.03200
2. `src/early_applicant.py:4-14` - fused score 0.03089
3. `tests/test_boost_system.py:113-128` (test_pillar1_tier_classification_less_than_20) - fused score 0.03055

**q040** (file_lookup) - Which file implements the SmartApply database writes for pipeline runs?

recall@5 0.0% | recall@10 100.0% | MRR@10 0.167 | nDCG@10 0.356 | first chunk rank 6 | first file rank 6

1. `tests/test_m6_challenger1_offline.py:274-297` (test_local_file_integrity_under_all_failures) - fused score 0.02899
2. `tests/test_m6_reviewer2_adversarial.py:293-321` (test_adv_db_local_file_preservation_on_error) - fused score 0.02762
3. `src/archive_packager.py:354-433` (package_pipeline_archive) - fused score 0.02597

**q041** (file_lookup) - Which file and function handles the Naukri application form for SmartApply?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 1

1. `src/bots/naukri_bot.py:1062-1071` (handle_chatbot_drawer) - fused score 0.02692
2. `src/bots/naukri_bot.py:322-370` (login_naukri) - fused score 0.02685
3. `src/bots/naukri_bot.py:1882-1961` (apply_to_jobs) - fused score 0.02532

**q042** (file_lookup) - Which file parses the Workday job pages for SmartApply?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 1

1. `src/scrapers/workday.py:74-80` (workday_detail) - fused score 0.03110
2. `src/batch_url_pipeline.py:502-513` (parse_job_from_url) - fused score 0.03080
3. `src/profile_manager.py:86-98` (load_desktop_resume_yaml) - fused score 0.02684

**q043** (file_lookup) - Which file contains the Pawna booking controller?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 2

1. `backend/controllers/dashboardController.js:1-3` (Booking) - fused score 0.03028
2. `backend/controllers/bookingController.js:473-475` - fused score 0.02808
3. `backend/controllers/bookingController.js:367-369` - fused score 0.02788

**q044** (file_lookup) - Which file defines the Pawna Booking Mongoose schema?

recall@5 100.0% | recall@10 100.0% | MRR@10 1.000 | nDCG@10 1.315 | first chunk rank 1 | first file rank 1

1. `backend/models/Booking.js:84-97` (bookingSchema) - fused score 0.03041
2. `backend/models/SiteSettings.js:1-13` (mongoose) - fused score 0.03009
3. `backend/models/BlockedDate.js:1-26` (mongoose) - fused score 0.02957

**q045** (file_lookup) - Where is the Pawna JWT authorization middleware defined?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.500 | nDCG@10 0.631 | first chunk rank 2 | first file rank 1

1. `backend/middleware/authMiddleware.js:1-29` (jwt) - fused score 0.03227
2. `backend/middleware/authMiddleware.js:32-41` (authorize) - fused score 0.03151
3. `backend/controllers/propertyController.js:14-39` (OWNER_FIELDS_PUBLIC) - fused score 0.02885

**q046** (file_lookup) - Which file contains the Pawna analytics controller?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 1

1. `backend/controllers/analyticsController.js:222-224` - fused score 0.02908
2. `backend/controllers/analyticsController.js:406-413` - fused score 0.02874
3. `backend/controllers/analyticsController.js:285-288` - fused score 0.02863

**q047** (file_lookup) - Which file has the script that removes plaintext passwords from the Pawna database?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 1

1. `backend/scripts/purge-plaintext-passwords.js:1-29` - fused score 0.03128
2. `backend/scripts/purge-plaintext-passwords.js:32-41` (dotenv) - fused score 0.03126
3. `backend/scripts/purge-plaintext-passwords.js:88-94` - fused score 0.03126

**q048** (file_lookup) - Which file implements the Personal AI OS chat edge function?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `supabase/functions/chat/.npmrc:1-3` - fused score 0.03028
2. `lib/features/chat/chat_screen.dart:232-243` - fused score 0.02845
3. `lib/features/chat/data/chat_repository.dart:102-107` (chatSessions) - fused score 0.02703

**q049** (file_lookup) - Which file implements the Aura Gemini Live relay?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.333 | nDCG@10 1.232 | first chunk rank 3 | first file rank 1

1. `server/geminiLiveRelay.js:58-63` - fused score 0.03175
2. `server/geminiLiveRelay.js:1-8` - fused score 0.03132
3. `server/geminiLiveRelay.js:624-631` (handleGeminiLiveRelay) - fused score 0.03110

**q050** (file_lookup) - Which file holds the Aura brand policy rules for the voice agent?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.200 | nDCG@10 0.387 | first chunk rank 5 | first file rank 1

1. `server/brandPolicy.js:1-10` - fused score 0.03227
2. `server/brandPolicy.js:384-392` - fused score 0.03002
3. `server/orderDatabase.js:1-7` - fused score 0.02853

**q051** (architecture) - Show me the SmartApply pipeline architecture from scrape to tracker.

recall@5 50.0% | recall@10 50.0% | MRR@10 1.000 | nDCG@10 0.613 | first chunk rank 1 | first file rank 1

1. `src/scraper.py:862-867` (run_scraper) - fused score 0.02976
2. `src/scrapers/internshala.py:1-5` - fused score 0.02889
3. `src/resume_tailor.py:84-150` - fused score 0.02822

**q052** (architecture) - Walk me through the SmartApply architecture stage by stage.

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `src/resume_tailor.py:84-150` - fused score 0.03132
2. `src/prompts/tailoring_prompt.txt:1-40` - fused score 0.02905
3. `tests/test_m5_reviewer2_adversarial.py:1-19` - fused score 0.02671

**q053** (architecture) - How is the SmartApply architecture split between the scraper, the scorer and the tailors?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 3

1. `src/scraper.py:42-52` - fused score 0.02440
2. `tests/e2e/test_tier1_feature_coverage.py:15-19` - fused score 0.02280
3. `src/scorer.py:4-14` - fused score 0.02209

**q054** (architecture) - How does the SmartApply architecture handle the React dashboard and the Flask API?

recall@5 50.0% | recall@10 50.0% | MRR@10 0.333 | nDCG@10 0.307 | first chunk rank 3 | first file rank 3

1. `tests/test_m6_adversarial_stress.py:65-90` (test_adversarial_serve_react_path_traversal) - fused score 0.03150
2. `frontend/src/pages/Dashboard.jsx:1473-1552` (Dashboard) - fused score 0.03089
3. `app.py:532-540` (serve_react) - fused score 0.03068

**q055** (architecture) - Describe the Pawna booking architecture from the visitor's booking form to the database.

recall@5 50.0% | recall@10 50.0% | MRR@10 0.500 | nDCG@10 0.387 | first chunk rank 2 | first file rank 1

1. `backend/routes/bookingRoutes.js:100-103` - fused score 0.02889
2. `backend/routes/bookingRoutes.js:58-63` (bookings) - fused score 0.02698
3. `backend/controllers/analyticsController.js:369-404` (getOwnerRevenue) - fused score 0.02640

**q056** (architecture) - How is the Pawna architecture split between the visitor app, the owner dashboard and the API?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `backend/controllers/propertyController.js:14-39` (OWNER_FIELDS_PUBLIC) - fused score 0.02516
2. `backend/controllers/dashboardController.js:94-97` (getDashboardStats) - fused score 0.02163
3. `src/config/api.js:20-33` (API_BASE_URL) - fused score 0.01926

**q057** (architecture) - What does the Pawna backend architecture look like, including the routes and the rate limiters?

recall@5 50.0% | recall@10 50.0% | MRR@10 0.200 | nDCG@10 0.237 | first chunk rank 5 | first file rank 1

1. `backend/server.js:80-82` - fused score 0.02565
2. `backend/server.js:2-7` (dotenv) - fused score 0.02438
3. `backend/routes/authRoutes.js:6-10` - fused score 0.01977

**q058** (architecture) - How is the Pawna architecture secured - what sits between the public booking route and the owner routes?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `backend/routes/bookingRoutes.js:100-103` - fused score 0.03002
2. `backend/routes/bookingRoutes.js:91-94` - fused score 0.02991
3. `backend/routes/bookingRoutes.js:52-56` - fused score 0.02742

**q059** (architecture) - How does the Personal AI OS architecture go from a chat message to a database write?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 2

1. `lib/features/chat/data/chat_repository.g.dart:180-185` (ChatMessagesProvider.) - fused score 0.03080
2. `supabase/functions/chat/index.ts:300-306` (messages) - fused score 0.03062
3. `lib/features/chat/data/chat_repository.dart:102-107` (chatSessions) - fused score 0.03033

**q060** (architecture) - Describe the Personal AI OS architecture: Flutter app, edge function and Supabase.

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `lib/app.dart:5-17` (PersonalAiOsApp.) - fused score 0.03077
2. `lib/core/providers/supabase_provider.g.dart:15-38` (SupabaseClientProvider.) - fused score 0.02715
3. `lib/core/providers/supabase_provider.g.dart:43-49` (SupabaseClientProvider.) - fused score 0.02671

**q061** (architecture) - How does the Personal AI OS architecture handle the provider fallback chain?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `lib/core/providers/supabase_provider.g.dart:43-49` (SupabaseClientProvider.) - fused score 0.03028
2. `lib/features/chat/data/chat_repository.g.dart:43-49` (ChatRepositoryProvider.) - fused score 0.02921
3. `lib/features/chat/data/chat_repository.g.dart:108-136` (ChatSessionsProvider.) - fused score 0.02863

**q062** (architecture) - Describe the Aura voice architecture from the browser microphone to Gemini Live and back.

recall@5 0.0% | recall@10 50.0% | MRR@10 0.100 | nDCG@10 0.177 | first chunk rank 10 | first file rank 6

1. `server/geminiLiveRelay.js:1-8` - fused score 0.02991
2. `server/geminiLiveRelay.js:58-63` - fused score 0.02942
3. `server/geminiLiveRelay.js:624-631` (handleGeminiLiveRelay) - fused score 0.02872

**q063** (architecture) - How is the Aura architecture split between the client hook, the relay and the policy layer?

recall@5 50.0% | recall@10 50.0% | MRR@10 0.500 | nDCG@10 1.124 | first chunk rank 2 | first file rank 1

1. `server/geminiLiveRelay.js:1-8` - fused score 0.03068
2. `server/geminiLiveRelay.js:144-223` (handleGeminiLiveRelay) - fused score 0.02973
3. `server/geminiLiveRelay.js:624-631` (handleGeminiLiveRelay) - fused score 0.02895

**q064** (architecture) - How does the Aura architecture record a call and then summarise it?

recall@5 0.0% | recall@10 50.0% | MRR@10 0.111 | nDCG@10 0.185 | first chunk rank 9 | first file rank 1

1. `server/transcriptManager.js:120-137` (TranscriptManager.recordToolCall) - fused score 0.03150
2. `src/hooks/useVoiceAgent.js:13-20` (CALL_STATES) - fused score 0.02889
3. `server/summarizer.js:1-8` - fused score 0.02859

**q065** (architecture) - What is the overall architecture of the SmartApply standalone dashboard?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 2

1. `tests/test_m1_challenger2_boundaries.py:51-60` (test_dashboard_has_no_deprecated_models) - fused score 0.02550
2. `standalone_dashboard/server.py:4-12` - fused score 0.02440
3. `standalone_dashboard/server.py:61-67` - fused score 0.02410

**q066** (data_model) - What does the Job record look like in SmartApply?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `tests/test_m5_ats_pdf.py:40-49` (sample_job_qa) - fused score 0.02905
2. `tests/test_m5_ats_pdf.py:53-62` (sample_job_java) - fused score 0.02837
3. `tests/conftest.py:122-137` (sample_senior_lead_job) - fused score 0.02614

**q067** (data_model) - How does SmartApply initialise its database tables?

recall@5 50.0% | recall@10 100.0% | MRR@10 0.500 | nDCG@10 0.591 | first chunk rank 2 | first file rank 2

1. `tests/test_m6_challenger1_offline.py:209-220` (test_missing_tables_does_not_crash) - fused score 0.03252
2. `setup_db.py:89-99` (setup_db) - fused score 0.03178
3. `tests/test_m3_challenger2_independent.py:40-67` - fused score 0.02885

**q068** (data_model) - How are pipeline runs and their metrics persisted in SmartApply?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `tests/test_m6_challenger1_offline.py:300-332` (test_telemetry_calculation_with_omitted_telemetry_succeeds) - fused score 0.02971
2. `app.py:246-325` (run_pipeline) - fused score 0.02872
3. `tests/test_m6_challenger2_gen2_verify.py:24-35` (reset_pipeline) - fused score 0.02786

**q069** (data_model) - What fields does the Pawna Booking collection store?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.333 | nDCG@10 0.500 | first chunk rank 3 | first file rank 3

1. `backend/routes/bookingRoutes.js:58-63` (bookings) - fused score 0.02661
2. `backend/controllers/dashboardController.js:1-3` (Booking) - fused score 0.02604
3. `backend/models/Booking.js:84-97` (bookingSchema) - fused score 0.02409

**q070** (data_model) - What does the Pawna Property schema look like?

recall@5 0.0% | recall@10 100.0% | MRR@10 0.167 | nDCG@10 0.961 | first chunk rank 6 | first file rank 1

1. `backend/models/Property.js:3-5` - fused score 0.03128
2. `backend/models/Property.js:171-175` - fused score 0.02804
3. `backend/routes/propertyRoutes.js:1-12` (express) - fused score 0.02026

**q071** (data_model) - How does the Pawna backend connect to MongoDB?

recall@5 50.0% | recall@10 50.0% | MRR@10 0.500 | nDCG@10 0.387 | first chunk rank 2 | first file rank 2

1. `backend/server.js:8-18` (helmet) - fused score 0.03200
2. `backend/config/db.js:1-21` (mongoose) - fused score 0.03150
3. `backend/routes/propertyRoutes.js:47-50` - fused score 0.02938

**q072** (data_model) - What data does the Pawna user model keep?

recall@5 100.0% | recall@10 100.0% | MRR@10 1.000 | nDCG@10 1.356 | first chunk rank 1 | first file rank 1

1. `backend/models/User.js:76-79` - fused score 0.02724
2. `backend/controllers/dashboardController.js:1-3` (Booking) - fused score 0.02389
3. `backend/models/Revenue.js:70-72` - fused score 0.02055

**q073** (data_model) - What tables does the Personal AI OS database schema create?

recall@5 100.0% | recall@10 100.0% | MRR@10 0.500 | nDCG@10 1.562 | first chunk rank 2 | first file rank 2

1. `supabase/migrations/20260929160000_align_schema.sql:1-40` - fused score 0.03227
2. `supabase/migrations/20260927181037_init_schema.sql:1-40` - fused score 0.03227
3. `supabase/migrations/20260927181037_init_schema.sql:31-70` - fused score 0.03175

**q074** (data_model) - What does the align_schema migration change in the Personal AI OS database?

recall@5 100.0% | recall@10 100.0% | MRR@10 1.000 | nDCG@10 2.243 | first chunk rank 1 | first file rank 1

1. `supabase/migrations/20260929160000_align_schema.sql:1-40` - fused score 0.03178
2. `supabase/migrations/20260927181037_init_schema.sql:1-40` - fused score 0.03178
3. `supabase/migrations/20260929160000_align_schema.sql:31-70` - fused score 0.03175

**q075** (data_model) - Where does Aura keep its order records?

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 1

1. `server/orderDatabase.js:236-241` - fused score 0.03041
2. `server/orderDatabase.js:143-148` - fused score 0.03008
3. `server/server.js:93-110` (orders) - fused score 0.02879

**q122** (comparison) - SmartApply and the standalone dashboard both score jobs. How are they different?

recall@5 50.0% | recall@10 50.0% | MRR@10 0.250 | nDCG@10 0.264 | first chunk rank 4 | first file rank 4

1. `standalone_dashboard/server.py:153-169` (get_summary) - fused score 0.03030
2. `standalone_dashboard/README.md:1-40` - fused score 0.02921
3. `standalone_dashboard/README.md:31-70` - fused score 0.02908

**q123** (comparison) - Compare how Pawna and SmartApply both track state in a database.

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank 5

1. `src/resume_tailor.py:84-150` - fused score 0.03089
2. `context/knowledge_graph.md:31-70` - fused score 0.02903
3. `backend/models/User.js:76-79` - fused score 0.02545

**q124** (comparison) - Compare the AI providers used across SmartApply, Aura and Personal AI OS.

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `src/resume_tailor.py:84-150` - fused score 0.02837
2. `lib/features/chat/data/chat_repository.g.dart:108-136` (ChatSessionsProvider.) - fused score 0.02582
3. `tests/test_ai_engine_multiprovider.py:10-14` - fused score 0.02211

**q125** (comparison) - Compare the test strategy of SmartApply and Aura.

recall@5 0.0% | recall@10 0.0% | MRR@10 0.000 | nDCG@10 0.000 | first chunk rank - | first file rank -

1. `tests/test_m5_reviewer2_adversarial.py:1-19` - fused score 0.02798
2. `server/server.js:210-220` - fused score 0.02748
3. `tests/test_m4_auditor_adversarial.py:128-138` (test_auditor_zero_hallucination_adversarial_injection) - fused score 0.02558


<!--ANSWER-RESULTS-->

Measured **2026-10-21T12:52:15.722Z** against the live `/api/chat` route over HTTP. 150 questions, 80 of them passing.

### Overall

| metric | value |
|---|---|
| pass rate (all checks) | **53.3%** |
| pass rate (ignoring the visual checks) | 60.0% |
| total cost | **$0.153169** |
| cost per question | $0.001021 |
| tokens | 1306368 cache-hit + 626387 cache-miss + 92154 completion |
| latency | p50 6620 ms, p90 9787 ms |
| dropped citations | 22 across the run |

The recomputed cost from the three token counts (cache hit $0.003/M, cache miss $0.15/M, completion $0.60/M) is $0.153170, which matches the cost the app itself booked. That is the whole run: about fifteen cents for a hundred and fifty answers.

### Per bucket

| bucket | passed | n | pass rate |
|---|---|---|---|
| code_explanation | 12 | 30 | 40.0% |
| file_lookup | 12 | 20 | 60.0% |
| architecture | 1 | 15 | 6.7% |
| data_model | 3 | 10 | 30.0% |
| metrics | 10 | 15 | 66.7% |
| claim_correction | 20 | 25 | 80.0% |
| comparison | 4 | 10 | 40.0% |
| off_topic_refusal | 15 | 15 | 100.0% |
| adversarial_prompt_injection | 3 | 10 | 30.0% |

### Which check fails

A question fails when any of its checks fails. The tally says which check is the expensive one.

| check | failed | of |
|---|---|---|
| `evidence` | 47 | 79 |
| `visualKind` | 17 | 95 |
| `confidence` | 7 | 150 |
| `answerContains` | 2 | 150 |
| `claim:smartapply-volume` | 2 | 3 |
| `claimVisual:smartapply-weasyprint` | 2 | 2 |
| `claim:campflow-owners` | 1 | 2 |
| `claim:pawna-name` | 1 | 1 |
| `claim:campflow-realtime-push` | 1 | 1 |
| `claimVisual:campflow-realtime-push` | 1 | 1 |
| `claim:pawna-security` | 1 | 2 |
| `claimVisual:c54-stack` | 1 | 2 |

### The citation failures, broken down

Of the 47 questions that failed the citation check:

- **35** cited the right FILE but not the expected chunk.
- **7** cited a different file entirely.
- **5** returned no citation at all: the model answered from the content layer and never touched the source index.

### The confidence the model reported

| confidence | answers |
|---|---|
| high | 90 |
| low | 26 |
| medium | 34 |

### The tools the model reached for

| tool | calls |
|---|---|
| `render_visual` | 146 |
| `search_code` | 105 |
| `get_claim` | 99 |
| `get_project` | 56 |
| `get_architecture` | 21 |
| `get_metrics` | 19 |
| `get_data_model` | 18 |
| `read_file` | 12 |
| `find_symbol` | 9 |
| `compare_projects` | 9 |
| `get_profile` | 7 |

### The 10 worst failures

**q101** (claim_correction) - Are the CampFlow analytics dashboards real-time, and do push notifications work for owners?

- `visualKind`: expected claims, got none
- `claim:campflow-realtime-push`: the approved public wording is NOT reproduced: "Analytics dashboards and a PWA shell; push notifications are partial."
- `claimVisual:campflow-realtime-push`: the claims visual declares null

visual: `null` - citations: []

> I don't have a project called CampFlow in this portfolio, so I can't answer whether its dashboards are real-time or whether owner push notifications work. The indexed and verified projects are smartapply, pawna, c54, aura, personal-ai-os, dayscore and copilot. If you meant one of those — for example a dashboard or notification feature in one of them — name it and I'll check the code.

**q123** (comparison) - Compare how Pawna and SmartApply both track state in a database.

- `answerContains`: missing: MongoDB
- `visualKind`: expected comparison, got data-model
- `evidence`: no citation for: src/tracker.py:101-157

visual: `{"kind":"data-model","projectId":"smartapply"}` - citations: ["backend/models/BlockedDate.js:1-28","backend/models/Booking.js:1-114","backend/models/Package.js:1-53"]

> 

**q041** (file_lookup) - Which file and function handles the Naukri application form for SmartApply?

- `answerContains`: missing: handle_form_questionnaire
- `evidence`: no citation for: src/bots/naukri_bot.py:762-899

visual: `{"kind":"code","projectId":"smartapply","path":"src/bots/naukri_bot.py","startLine":377,"endLine":410}` - citations: ["src/bots/naukri_bot.py:377-410","src/bots/naukri_bot.py:1962-2041"]

> The Naukri application flow lives in **`src/bots/naukri_bot.py`**. The driving loop is `apply_to_jobs` — the form filling, the "Submit and Apply" click, the rate-limit check after submission and the post-submit verification guard all sit inside it (chunks at lines 1882-1961 and 1962-2041). Field answers for questionnaire widgets are generated by the helper `apply_strict_type_guard(question_text)` at **lines 377-410**: it keyword-matches the question text and returns a fixed answer (city → "Pune", relocate → "Yes", notice period → "0"/"Immediate", expected CTC → "400000", degree → "B.E / B.Tech"), or `None` when nothing matches. Its docstring states the intent: to guarantee valid field formatting so inputs like "0 LPA" for a city cannot occur. Caveat: I read only those chunks, so I did not verify whether `apply_strict_type_guard` is actually called from inside `apply_to_jobs` — the connec

**q054** (architecture) - How does the SmartApply architecture handle the React dashboard and the Flask API?

- `visualKind`: expected architecture, got flow
- `evidence`: no citation for: frontend/src/components/tracker/KanbanBoard.jsx:15-71

visual: `{"kind":"flow","projectId":"smartapply"}` - citations: ["frontend/src/pages/Dashboard.jsx:1473-1552","app.py:532-540","tests/test_m6_supabase_ui.py:108-115"]

> I'll check the architecture capture and the claim ledger.SmartApply splits into a React SPA and a Flask backend that also serves it. The dashboard component fetches `GET /api/status` once on mount with `useState`/`useEffect`, then opens an `EventSource` on `/api/stream` and overwrites the same state object on every SSE message (Dashboard.jsx:1473-1552). Pipeline runs are kicked off by `POST /api/start`, or `/api/test-start` in test mode, with platforms, job types, hours-old, model and thinking settings in the JSON body. On the server side, Flask doubles as the static host: `serve_react` (app.py:532-540) serves files out of `app.static_folder` and falls back to `index.html` for client-side routes, returning a 404 with "Frontend dist not built. Please run npm run build in frontend/" when no build exists. A test at tests/test_m6_supabase_ui.py:108-115 asserts `/tracker`, `/pipeline` and `/j

**q058** (architecture) - How is the Pawna architecture secured - what sits between the public booking route and the owner routes?

- `visualKind`: expected architecture, got flow
- `evidence`: no citation for: backend/server.js:43-65

visual: `{"kind":"flow","projectId":"pawna"}` - citations: ["backend/middleware/authMiddleware.js:1-29","backend/middleware/authMiddleware.js:32-41","backend/routes/propertyRoutes.js:31-35"]

> I'll check the claim ledger and the Pawna code.Two JWT middlewares sit between the public booking route and the owner routes: `protect`, then `authorize('manager')`. `protect` (backend/middleware/authMiddleware.js:1-29) requires a `Bearer` header, calls `jwt.verify` with `process.env.JWT_SECRET`, loads the user via `User.findById(decoded.id).select('-password')`, returns 401 if there is no user or the token fails, otherwise calls `next()`. `authorize(...roles)` (:32-41) returns 403 when `req.user.role` is not in the allowed list. The manager-only block in backend/routes/propertyRoutes.js:31-35 applies both with `router.use`, so every route registered after that line is gated. The public booking route is different by design: `POST /api/bookings` reaches the booking controller without `protect`, which is exactly why the ledger marks security as partial.

**q064** (architecture) - How does the Aura architecture record a call and then summarise it?

- `visualKind`: expected architecture, got flow
- `evidence`: no citation for: server/transcriptManager.js:24-52

visual: `{"kind":"flow","projectId":"aura"}` - citations: ["server/summarizer.js:224-303","server/geminiLiveRelay.js:544-623","server/summarizer.js:78-86"]

> Aura records a call as a turn transcript plus tool events, then summarises it after `end_call`. In the relay, audio arrives as base64 16 kHz PCM and is forwarded to Gemini Live as `realtimeInput`; transcribed turns go into a `transcriptManager`, and interruptions are handled so a cut-off Aria turn is marked final. When the client sends `end_call`, the relay calls `finalizeSession()`. Summarisation lives in `server/summarizer.js`: `generateCallSummary` takes the transcript turns and tool calls, prompts Gemini with JSON mode for `customer_intent`, `order_id`, `resolution_status` and a 2–3 sentence `call_summary`, then validates the parsed result. If there are no turns, no API key, or the model call throws, it falls back to the rule-based extractor, which the code documents as regex/heuristic based and offline. Caveat: the content layer cites `server/summary.js` while the indexed file is `s

**q071** (data_model) - How does the Pawna backend connect to MongoDB?

- `visualKind`: expected data-model, got code
- `evidence`: no citation for: backend/models/Booking.js:1-3

visual: `{"kind":"code","projectId":"pawna","path":"backend/config/db.js","startLine":1,"endLine":21}` - citations: ["backend/config/db.js:1-21","backend/scripts/purge-plaintext-passwords.js:43-86"]

> I'll check the Pawna source for connection code.The Pawna backend uses Mongoose over a single `MONGODB_URI` environment variable, wrapped in a retry loop rather than a one-shot connect. `backend/config/db.js` (lines 1–21) exports `connectDB`, an async function defaulting to `retries = 5`. It calls `await mongoose.connect(process.env.MONGODB_URI)`, logs the connection host on success, and on a thrown error decrements the counter, logs the failure, waits 5 seconds and retries. When retries hit zero it logs a fatal message and calls `process.exit(1)` — so a missing database kills the process instead of leaving it half-alive. The URI is never hardcoded. The same env var is read by standalone scripts: `backend/scripts/purge-plaintext-passwords.js` (lines 43–86) exits immediately if `MONGODB_URI` is unset, connects directly, works on `mongoose.connection.collection('users')`, and calls `mongoo

**q075** (data_model) - Where does Aura keep its order records?

- `visualKind`: expected data-model, got code
- `evidence`: no citation for: server/orderDatabase.js:95-141

visual: `{"kind":"code","projectId":"aura","path":"server/orderDatabase.js","startLine":193,"endLine":234}` - citations: ["server/orderDatabase.js:193-234","server/orderDatabase.js:14-90","server/server.js:93-110"]

> Aura keeps its order records in memory, in a plain JavaScript object exported from `server/orderDatabase.js`. There is no database, no schema and no migration: the data model was not captured because none exists in the indexed source. The mechanism: `SEED_ORDERS` (lines 14-90) is an object literal keyed by order id — `ORD-101`, `ORD-102`, `ORD-103` — each holding customer name, items, amount in INR, status, courier and tracking number. `getOrderDetails` (lines 193-234) normalises the id, indexes into that object, and returns a standardised payload for the Gemini tool response; unknown ids return `status: 'not_found'`. It is imported as `db` in that function, with `resetOrderDatabase` restoring the seed data via `POST /api/orders/reset`. The code doesn't state why it is in-memory. Inference: the assessment needed deterministic, resettable fixtures rather than real persistence. Caveat: mut

**q095** (claim_correction) - Does SmartApply render the resume PDF with WeasyPrint?

- `visualKind`: expected claims, got code
- `claimVisual:smartapply-weasyprint`: the claims visual declares null

visual: `{"kind":"code","projectId":"smartapply","path":"src/pdf_generator.py","startLine":94,"endLine":139}` - citations: ["src/pdf_generator.py:94-139","tests/test_m5_ats_pdf.py:1-20"]

> No. That claim is not supported. What the repo actually does is render the ATS-oriented resume PDF with Jinja2 HTML templates and headless Playwright Chromium, not WeasyPrint. The mechanism, from `src/pdf_generator.py` lines 94-139: `generate_resume_pdf()` loads `resume_template.html` through a Jinja2 `Environment`, renders it with the tailored resume dict and job, sets the HTML on a Chromium page via `page.set_content(html_out)`, and calls `page.pdf()` with A4, print background and zero margins. The docstring documents it as "Generate a 1-page ATS-friendly PDF resume directly to output_path." Output is then audited with `ats_verifier.audit_resume_pdf()` using pypdf and PyMuPDF (fitx), and `tests/test_m5_ats_pdf.py` lines 1-20 asserts a real 1-page PDF and machine-readable text extraction. WeasyPrint is never imported anywhere in the indexed code. The approved wording for this: "The pipe

**q096** (claim_correction) - Which template engine and renderer actually produce the ATS PDF in SmartApply?

- `visualKind`: expected claims, got code
- `claimVisual:smartapply-weasyprint`: the claims visual declares null

visual: `{"kind":"code","projectId":"smartapply","path":"src/pdf_generator.py","startLine":94,"endLine":139}` - citations: ["src/pdf_generator.py:94-139","src/pdf_generator.py:10-89","tests/test_m5_ats_pdf.py:91-105"]

> I'll check the claim ledger and the indexed code.**Jinja2 templates rendered to PDF by Playwright's headless Chromium.** There is no WeasyPrint and no LaTeX/ReportLab stage anywhere in the indexed code. The mechanism, from `src/pdf_generator.py`: a Jinja2 `Environment` with a `FileSystemLoader` pointed at the repo's `templates/` dir loads `resume_template.html`, and `template.render(resume=tailored_resume, job=job)` produces HTML (lines 94–139). That HTML goes to `page.set_content(html_out)`, then `page.pdf(format="A4", print_background=True, margin=0)`. Margins are handled in CSS. Two entry points exist: `generate_pdf` (lines 10–89) reuses a shared Playwright page; `generate_resume_pdf` (94–139) opens its own `sync_playwright()` Chromium session. The claim that PDFs are rendered with WeasyPrint is **not supported by the code** — WeasyPrint is not imported. The approved wording is: "The 


<!--FINDINGS-->

---

## 7. The next improvement

<!--NEXT-STEPS-->
