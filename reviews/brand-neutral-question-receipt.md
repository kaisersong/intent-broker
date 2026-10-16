# Brand-neutral question delivery receipts

The live Xiaok plugin invokes the Intent Broker bundled in the installed app.
Both Xiaok and Claude Code AskUserQuestion pre-hooks name HexDeck in the tool
receipt, despite the broker receipt not identifying a receiving application.
The model then repeats that unsupported application name.

Share one neutral receipt across both adapters: questions were submitted through
Intent Broker, await the user's reply, do not open a duplicate terminal prompt,
and do not infer a client name or assistant identity from transport metadata.
Keep forwarding, pending-tool bookkeeping, continuation control and approval
semantics unchanged. Preserve existing user/session history.

Review boundaries: user-authored question text may legitimately name a product;
do not rewrite it. Failed forwarding must not claim submission. Skip-sync still
skips forwarding. Both adapter paths and formatted Claude output must carry the
same neutral receipt. A local install must update the actual plugin command
entry, not merely the source checkout or the signed app's contents.

Validation: both adapters failed the new neutral-receipt regression on the old
implementation. Focused hooks/install checks passed 41 tests. Final full suite
passed 577 with 14 existing skips; collaboration smoke passed. Actual CLI hook
subprocesses for Xiaok and Claude sent a synthetic question to a private loopback
HTTP fixture, preserved the payload and emitted the neutral receipt. The locally
configured Xiaok PreToolUse entry was updated to the stable repaired checkout
and passed the same subprocess check; all other installed hook commands, user
settings, application bundle signatures and historical session data were preserved.
Owned test hook processes exited and fixture HTTP servers were closed. Existing
running Xiaok processes need restart/resume to load the changed hook command.
