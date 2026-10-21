/**
 * adapter / core 产生的「数据型」用户可见文案的英文映射。
 *
 * 这些字符串的主进程来源是 @sessionport/core 与各 adapter 的 LossCollector /
 * notices；桌面端不能改这些包，所以 renderer 按 code 映射，查不到时回退到
 * 原文（中文）。中文界面直接使用原文，不做二次翻译。
 *
 * 动态参数（模型名、路径、错误文本等）没有随 LossEntry 传过来；英文文案
 * 用概括表述，UI 会在 hover 时展示原文以保留诊断细节。
 */

export const enLossMessages: Record<string, string> = {
  'claude.reasoning-dropped':
    'thinking / reasoning blocks were not exported (Claude requires Anthropic-signed thinking blocks, which cannot be forged across sources)',
  'claude.boundary-dropped':
    'Conversation boundary events (branch/undo/compact/cancel) have no equivalent in Claude',
  'claude.tool-result-synthesized':
    'Tool calls without a matching result were given placeholder tool_result entries so Claude can load the session',
  'claude.orphan-tool-result': 'Orphan tool_result (no matching tool_use in the source session) was downgraded to text',
  'claude.cross-agent-import':
    "The session came from another agent; model/tool semantics are approximated to Claude's structure",
  'claude.model-not-mapped':
    'The source model is not a Claude model name; the target falls back to its default model',
  'claude.subagent-dropped': "Subagent sessions were not exported (Claude's inline sidechain semantics are not implemented yet)",
  'claude.subagent-events-dropped': 'Subagent session events were not exported',
  'claude.source-undo':
    'Content undone at the source was already removed in the IR; the target sees the post-undo context',
  'claude.subagent-separate-session':
    "Subagent sessions were exported as standalone sessions; Claude's inline sidechain structure is not implemented, so parent/child links are lost",

  'codex.injected-message-dropped':
    'Target-injected messages (runtime context, skill listings, etc.) were dropped; Codex injects its own',
  'codex.opaque-reasoning-dropped': 'Source reasoning is encrypted (no plaintext available) and was dropped',
  'codex.boundary-dropped': 'Conversation boundary event has no equivalent in the Codex rollout',
  'codex.tool-result-synthesized': 'Tool calls without a matching result were given placeholder output',
  'codex.cross-agent-import':
    "The session came from another agent; message/tool semantics are approximated to Codex's rollout format",
  'codex.subagent-dropped': 'Codex has no standalone subagent transcript; subagent sessions were not exported',
  'codex.subagent-events-dropped': 'Subagent session events were not exported',
  'codex.model-not-mapped': 'The source model was not written to session metadata; Codex uses its configured model',
  'codex.session-index-failed': 'Failed to write session_index.jsonl',
  'codex.threads-row-failed': 'Failed to write the state_5.sqlite threads row (does not affect the rollout)',

  'command-code.image-dropped': 'An IR image reference could not be resolved and was dropped',
  'command-code.invalid-timestamp':
    'An IR event timestamp was not valid ISO 8601; a nearby timestamp was used instead',
  'command-code.empty-message-dropped': 'Empty user messages were dropped',
  'command-code.injected-message-dropped':
    'Target-injected messages (runtime context, skill listings, subagent notices, etc.) were dropped; the target generates its own runtime context',
  'command-code.reasoning-opaque-dropped': 'Opaque reasoning has no native Command Code structure and was dropped',
  'command-code.tool-error-flag-dropped':
    "Command Code's tool_result has no is_error field; the error flag was dropped (error text remains in content)",
  'command-code.boundary-dropped':
    'Conversation boundary events (branch/undo/compact/cancel) have no equivalent in Command Code',
  'command-code.tool-result-synthesized':
    'Tool calls without a matching result were given placeholder tool_result entries so the session can load',
  'command-code.orphan-tool-result': 'Orphan tool_result (no matching tool_use) was downgraded to text',
  'command-code.cross-agent-import':
    "The session came from another agent; message/tool semantics are approximated to Command Code's structure",
  'command-code.model-omitted':
    'The IR provided no model; assistant rows omit the model field and the target falls back to its configured model',
  'command-code.subagent-dropped':
    'Subagent sessions were not exported (use --include-children to export them as standalone sessions)',
  'command-code.subagent-events-dropped': 'Subagent session events were not exported',
  'command-code.source-undo':
    'Content undone at the source was already removed in the IR; the target sees the post-undo context',
  'command-code.sidecars-not-written':
    'UI indexes (checkpoints/prompts/history/thread-index) were not written; resume does not need them, but /rewind and history lose extra metadata',
  'command-code.subagent-separate-session':
    'Subagent sessions were exported as standalone sessions; Command Code has no parent/child structure, so the relationship cannot be expressed',
  'command-code.register-skipped': 'Desktop registration did not complete',

  'cursor.synthetic-user-dropped':
    'Runtime-injected user messages (synthetic) were dropped; Cursor injects its own context',
  'cursor.empty-message-dropped': 'Empty messages (only images/attachments) had no text to write and were dropped',
  'cursor.opaque-reasoning-dropped': 'Source reasoning is encrypted/opaque and was dropped',
  'cursor.tool-result-missing': 'A tool call has no result; a bubble with status=cancelled was written',
  'cursor.tool-result-image-dropped':
    'Images in the tool result have no local binary; only placeholder text was written',
  'cursor.extra-tool-result':
    'A tool call has multiple results; a Cursor bubble can inline only one, so extra results were dropped',
  'cursor.orphan-tool-result': 'A tool result with no matching tool_call was dropped explicitly',
  'cursor.boundary-dropped': 'Conversation boundary events have no equivalent in Cursor',
  'cursor.images-dropped': 'Images (image parts) had no local binary and were dropped',
  'cursor.subagent-dropped': "Cursor's subagent composer structure is complex; subagent sessions were not exported",
  'cursor.subagent-events-dropped': 'Subagent session events were not exported',
  'cursor.cross-agent-import': "The session came from another agent; messages are approximated to Cursor's composer format",
  'cursor.workspace-id-fallback':
    'The target directory does not exist; workspaceId falls back to md5(cwd) (this may differ from Cursor’s derivation)',

  'dsh.reasoning-opaque-dropped': 'Opaque/encrypted reasoning cannot become a DSH reasoning block and was dropped',
  'dsh.boundary-dropped':
    'The DSH session format has no generic fork/undo/compact/cancel structure; boundary events were dropped',
  'dsh.image-part-dropped':
    'Message images in a DSH session require the attachment mechanism, which cannot be forged across agents; images were dropped',
  'dsh.tool-result-json-as-text': 'A JSON tool result was serialized as a text block',
  'dsh.tool-result-image-dropped':
    'A tool-result image could not be mapped to a DSH attachment and was downgraded to a text placeholder',
  'dsh.system-prompt-synthesized':
    'An empty system/message was written to occupy surface node 0; DSH injects its own system prompt on the next request',
  'dsh.empty-user-message-dropped': 'A user message had no exportable text part and was skipped',
  'dsh.empty-assistant-step-dropped':
    'A step had no exportable assistant content (empty message); assistant/message was skipped',
  'dsh.tool-result-without-call-id': 'A tool/result had no callId and was skipped',
  'dsh.orphan-tool-result-dropped': 'Orphan tool/result (no matching tool_call) was dropped',
  'dsh.tool-result-synthesized': 'A tool_call had no matching result; a placeholder tool/result was added',
  'dsh.slim-old-tool-events-dropped':
    'Slim import: tool_call/tool_result events from earlier steps were dropped (only recent steps keep tool interactions)',
  'dsh.summary-llm': 'Generated an LLM summary with an external CLI',
  'dsh.summary-llm-failed': 'LLM summary failed; fell back to an extractive summary',
  'dsh.compact-skipped': 'Not enough steps or no contiguous surface range; no compaction was generated',
  'dsh.compacted-checkpoint':
    "Compacted context with DSH's native compaction chain: the full event log is kept; model context = summary + recent steps",
  'dsh.slim-old-steps-omitted':
    'Slim import: kept full tool results for recent steps; earlier results were replaced with placeholders',
  'dsh.slim-reasoning-dropped': 'Slim import: reasoning blocks from earlier steps were dropped (recent steps kept)',
  'dsh.slim-tool-result-truncated': 'Slim import: tool_result text was truncated',
  'dsh.slim-tool-call-arguments-truncated': 'Slim import: tool_call arguments were truncated',
  'dsh.cross-agent-import':
    'The session came from another agent and was approximated to the DSH v4 event stream; source-specific structures are downgraded per the loss list',
  'dsh.model-selection-dropped':
    'The source model was not migrated by design; the target uses its default model (switchable in the session)',
  'dsh.child-session-write-failed': 'Failed to write a subagent session',
  'dsh.subagent-dropped':
    'Subagent sessions were not exported (includeChildren=false); DSH stores subagents as separate session files',
  'dsh.subagent-events-dropped': 'Subagent session events were not exported',
  'dsh.workspace-register-failed': 'Failed to register workspace.json (does not affect session files)',

  'opencode.injected-message-dropped': 'Target-injected messages (runtime context/skill listings, etc.) were dropped',
  'opencode.opaque-reasoning-dropped': 'Source reasoning is encrypted and was dropped',
  'opencode.orphan-tool-result': 'Orphan tool_result (no matching call) was dropped',
  'opencode.boundary-dropped': 'Conversation boundary events were not mapped into the opencode export format',
  'opencode.tool-without-result': 'Tool calls have no result and are exported with a running status',
  'opencode.cross-agent-import':
    "The session came from another agent; message/tool semantics are approximated to opencode's export format",
  'opencode.subagent-dropped':
    'opencode subagents are an agent column on the session (not standalone sessions); subagent sessions were not exported',
  'opencode.subagent-events-dropped': 'Subagent session events were not exported',
  'opencode.import-failed': 'opencode import failed',

  'qoder.image-part-flattened': 'Image parts keep only an [image: ref] text reference; no inline image data',
  'qoder.synthetic-message-dropped':
    'The target injects its own context; synthetic user messages from the source were dropped',
  'qoder.empty-user-message': 'Empty user messages were dropped',
  'qoder.synthetic-assistant-dropped': 'Runtime status messages (such as "Interrupted by user") were dropped',
  'qoder.empty-assistant-message': 'Empty assistant messages were dropped',
  'qoder.opaque-reasoning-dropped':
    'Source reasoning is encrypted/unreadable; Qoder only accepts plaintext thinking',
  'qoder.boundary-dropped': 'Conversation boundaries have no corresponding Qoder row and were dropped',
  'qoder.cross-agent-import':
    "The session came from another agent; message/tool semantics are approximated to Qoder's transcript format",
  'qoder.model-pinned': 'The source model is unavailable in Qoder CN and was pinned to a supported model',
  'qoder.subagents-dropped': 'Qoder subagents are standalone transcripts; v0.1 does not export subagent sessions',
  'qoder.subagent-events-dropped': 'Subagent events were not written to Qoder',
  'qoder.tool-without-result': 'Tool calls have no result and appear as unfinished calls in Qoder',
  'qoder.empty-session': 'No rows were written',
  'qoder.backup': 'Backed up the previous file before overwriting',
};

export const enNoticeMessages: Record<string, string> = {
  'claude.bad-json-lines': 'Unparseable JSONL lines were skipped (possibly a partial write or corrupt file)',
  'claude.compact-boundary': 'compact_boundary was mapped to boundary(compact)',
  'claude.empty-thinking-block': 'Empty thinking blocks were skipped',
  'claude.image-block':
    'Image blocks were kept as data URIs / references; they may be lost when exporting to another agent',
  'claude.orphan-tool-result': 'tool_result without a matching tool_use (kept, but may be downgraded on re-export)',
  'claude.redacted-thinking': 'redacted_thinking was kept as opaque reasoning',
  'claude.sidechain-children': 'Inline sidechain mirror rows were grouped into child sessions',
  'claude.sidechain-skipped':
    'Ungroupable isSidechain rows were skipped (no agentId and no sidechain parentUuid)',
  'claude.subagent-mirror-extra-rows':
    'Mirror rows in the main file beyond the disk transcript were appended to the child session',
  'claude.subagent-transcripts': 'Read subagent transcripts from the subagents directory (disk is authoritative)',
  'claude.synthetic-user-message': 'isMeta / compact summary user messages were marked synthetic',
  'claude.system-lines-skipped': 'system lines (other than compact_boundary) were skipped',
  'claude.tool-without-result': 'Tool calls have no result (in progress or interrupted)',
  'claude.unknown-content-block': 'Unknown content block was skipped',
  'claude.unknown-line-type': 'Unknown line type was skipped',

  'codex.bad-lines': 'The rollout contains unparseable lines',
  'codex.developer-messages-skipped':
    'developer/system messages are runtime-injected instructions (skills, environment notes, etc.); the target generates its own, so they were skipped',
  'codex.event-msg-skipped': 'event_msg is a UI mirror duplicating response_item; skipped',
  'codex.opaque-reasoning': 'Reasoning only has encrypted content; kept as opaque reasoning',
  'codex.system-lines-skipped':
    'Runtime snapshots such as token_usage_record / world_state are not conversation content; skipped',
  'codex.tool-arguments-not-json': 'Some function_call arguments were not valid JSON; kept as raw strings',
  'codex.unknown-line': 'Unknown rollout structure was skipped',

  'command-code.bad-lines': 'There are unparseable JSON lines (the loader discards them as corrupted)',
  'command-code.effort': 'Source reasoning effort was not exported (the IR has no matching field)',
  'command-code.entry-': 'This entry type has no IR equivalent and was skipped',
  'command-code.forked-session': 'This session was produced by fork/clone; its parent transcript is recorded',
  'command-code.invalid-entries':
    'Some lines did not match the v3 entry shape (missing id/parentId/timestamp or unknown type)',
  'command-code.message-source': 'Non-standard message.meta.source was seen',
  'command-code.print-entrypoint': 'This session was produced in -p/print mode (entrypoint=print)',
  'command-code.subagent-not-exported':
    'Agent tool calls (subagents) have no standalone transcript; kept as normal tool_call entries',
  'command-code.system-reminder': 'The first user message starts with <system-reminder>',
  'command-code.tool-pairing': 'Tool calls/results were not fully paired',
  'command-code.unknown-block': 'Unmapped content block',

  'cursor.attached-context-skipped':
    'Code/file-selection context attached to user bubbles was not exported (re-select in Cursor)',
  'cursor.bad-bubble': "Failed to parse a bubble's JSON; skipped",
  'cursor.child-read-failed': 'Some subagent composers could not be read (missing data); skipped',
  'cursor.child-truncated': 'The number of subagent sessions exceeded the limit; only the first ones were read',
  'cursor.display-only-bubble': 'isDisplayOnly bubbles are UI-only content; skipped',
  'cursor.empty-bubble': 'Empty placeholder bubbles (no text/thinking/tool data) were skipped',
  'cursor.header-missing':
    'The composerHeaders row is missing (it may only exist in an old blob), so the session may be invisible in the list',
  'cursor.header-unparseable':
    'A composerHeaders value is not valid JSON (the session is still read from composerData)',
  'cursor.headers-missing':
    'composerData has no fullConversationHeadersOnly; falling back to bubble createdAt ordering',
  'cursor.image-metadata-only':
    'Images only have metadata (uuid/size); there is no binary in the local DB, so the IR uses a ref placeholder',
  'cursor.interpreter-results': 'interpreterResults (legacy tool results) were mapped to orphan tool_result entries',
  'cursor.missing-bubble':
    'A bubble listed in fullConversationHeadersOnly is missing from the DB (the session may have been partially cleaned)',
  'cursor.synthetic-user-message':
    'Cursor runtime-injected user messages (background task notices, etc.) were marked synthetic',
  'cursor.thinking': 'thinking blocks were mapped to IR reasoning (plain)',
  'cursor.tool-bubbles': 'toolFormerData was mapped to tool_call + tool_result',
  'cursor.tool-result-missing':
    'Tool calls have no recorded result (status not completed or result cleaned); only tool_call was kept',
  'cursor.unknown-bubble': 'Unknown bubble structure was skipped',

  'dsh.bad-jsonl-lines': 'The session log contains unparseable JSONL lines',
  'dsh.child-parent-link': 'This is a subagent session (parentSession is set); returned as a standalone session',
  'dsh.child-session-unreadable': 'Failed to read a subagent session',
  'dsh.duplicate-tool-result':
    'Multiple tool/result entries share a callId; later ones override in order (the IR keeps all)',
  'dsh.image-block-unread': 'An image block in user/message had no resolvable attachment reference; skipped',
  'dsh.missing-tool-result':
    'A tool_call has no matching tool/result (the session may be interrupted); a placeholder result is added on export',
  'dsh.no-conversation-events': 'This session has no mappable conversation events',
  'dsh.non-conversation-event': 'Non-conversation event was skipped',
  'dsh.orphan-tool-result': 'tool/result has no matching tool_call; the IR keeps it but the target may reject it',
  'dsh.synthetic-user-message': 'Runtime-injected user/message was marked synthetic',
  'dsh.tool-call-echo-dropped': 'tool/call duplicated a tool-call block in assistant content; skipped',
  'dsh.tool-call-recovered':
    'A tool-call block was missing from assistant content; recovered from the tool/call event',
  'dsh.tool-call-without-id': 'tool/call event had no callId; skipped',
  'dsh.torn-tail-recovered':
    'The session tail had an incomplete frame (crash/partial write); complete lines were recovered where possible',
  'dsh.unknown-content-block': 'Unmapped message content block was skipped',
  'dsh.unknown-event': 'Unknown DSH event type was skipped',

  'kimi.bad-wire-lines': 'wire.jsonl contains unparseable lines',
  'kimi.missing-subagent-wire': 'A subagent has no wire.jsonl',
  'kimi.prompt-echo-dropped': 'turn.prompt duplicated context.append_message; skipped',
  'kimi.runtime-events-dropped': 'Runtime/config/usage/step events are not conversation content; skipped',
  'kimi.ui-mirror-dropped': 'agent.message.appended is a UI mirror of the context event stream; skipped',
  'kimi.undone-turns-dropped': 'Turns undone at the source were removed from the IR (the undo boundary event is kept)',
  'kimi.unknown-event': 'Unknown wire event type',
  'kimi.version-ambiguous':
    'Version information is ambiguous: bundle manifest, session format, and wire protocol report different versions; the CLI version must be probed separately',

  'opencode.file-parts-skipped': 'file parts (attachments/snapshots) were not mapped into the IR',
  'opencode.step-parts-skipped': 'step-start/step-finish are streaming placeholders, not conversation content; skipped',
  'opencode.tool-without-output':
    'Tool calls have no completed output (in progress or interrupted); only the call was kept',
  'opencode.unknown-message-role': 'Messages with roles other than user/assistant were skipped',
  'opencode.unknown-part': 'Unknown part type was skipped',

  'qoder.attachments-skipped':
    'Qoder attachment rows (skill_listing/system_reminder, etc.) are not conversation content; skipped',
  'qoder.bad-json-lines': 'Unparseable JSONL lines were skipped (possibly a partial write)',
  'qoder.branch-pruned': 'Walked the active-leaf branch and discarded old branches left by edits/retries',
  'qoder.compact-boundary': 'compact_boundary was mapped to boundary(compact)',
  'qoder.empty-content-block': 'Empty text/thinking blocks were skipped',
  'qoder.image-part': 'Image blocks kept only references; no inline image data',
  'qoder.orphan-tool-result': 'tool_result without a matching tool_use',
  'qoder.progress-lines-skipped': 'progress lines are streaming progress; skipped',
  'qoder.redacted-thinking': 'redacted_thinking was kept as opaque reasoning',
  'qoder.subagents': 'Qoder subagent transcripts were read as child sessions',
  'qoder.synthetic-user-message': 'Runtime-injected/system-prompt user messages were marked synthetic',
  'qoder.system-lines-skipped': 'system lines (other than compact_boundary) were skipped',
  'qoder.tool-without-result': 'Tool calls have no result (in progress or interrupted)',
  'qoder.unknown-content-block': 'Unknown content block was skipped',
  'qoder.unknown-line': 'Unknown line type was skipped',

  'workbuddy.bad-json-lines': 'Unparseable JSONL lines were skipped (partial writes by the app)',
  'workbuddy.bad-tool-arguments': 'Tool arguments were not valid JSON; kept as { raw }',
  'workbuddy.credit-usage-skipped': 'credit-usage is billing telemetry; skipped',
  'workbuddy.empty-reasoning': 'Empty reasoning lines were skipped',
  'workbuddy.empty-user-message': 'Empty user messages (only attachment refs) were skipped',
  'workbuddy.failed-tool-result': 'Tool results with a non-completed status were marked isError',
  'workbuddy.file-snapshots-skipped': 'file-history-snapshot is backup metadata, not conversation content',
  'workbuddy.injected-user-message':
    'Context user messages injected by WorkBuddy (system-reminder/teammate-message) were marked synthetic',
  'workbuddy.interrupted-assistant':
    'Assistant messages interrupted by the user were marked synthetic (not model output)',
  'workbuddy.orphan-tool-result': 'Tool results with no matching call (session truncated/forked)',
  'workbuddy.resend-fork': 'resend-fork-notice was mapped to boundary(fork)',
  'workbuddy.subagents': 'Subagent sessions were read as children (triggered by the Agent tool)',
  'workbuddy.tool-without-result': 'Tool calls have no result (in progress or interrupted)',
  'workbuddy.unknown-line': 'Unknown line type was skipped',
};
