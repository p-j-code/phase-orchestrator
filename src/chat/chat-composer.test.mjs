import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import ChatView from '../public/js/components/ChatView.js';

const originalStorage = globalThis.localStorage;

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    snapshot() { return Object.fromEntries(values); },
  };
}

function chatComponent() {
  const vm = {
    ...ChatView.data(),
    $refs: { box: { focus() {} } },
    $nextTick(callback) { if (callback) callback(); },
  };
  Object.assign(vm, ChatView.methods);
  vm._activateComposer(null, { saveCurrent: false });
  return vm;
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
});

afterEach(() => {
  globalThis.localStorage = originalStorage;
});

test('draft text, pending uploads, and queued follow-ups remain scoped to their thread', () => {
  const vm = chatComponent();
  const newPending = { name: 'new-file', label: 'new.txt', previewUrl: 'blob:new' };
  const newQueued = { name: 'new-queued', label: 'queued.txt', previewUrl: 'blob:new-q' };
  vm.input = 'new-thread draft';
  vm.pendingFiles.push(newPending);
  vm.messageQueue.push({ text: 'new-thread follow-up', files: [newQueued] });
  vm._saveCurrentComposer();

  vm._activateComposer(17);
  assert.equal(vm.input, '');
  assert.deepEqual(vm.pendingFiles, []);
  assert.deepEqual(vm.messageQueue, []);

  const threadPending = { name: 'thread-file', label: 'thread.txt' };
  vm.input = 'thread 17 draft';
  vm.pendingFiles.push(threadPending);
  vm.messageQueue.push({ text: 'thread 17 follow-up', files: [] });
  vm._saveCurrentComposer();

  vm._activateComposer(null);
  assert.equal(vm.input, 'new-thread draft');
  assert.deepEqual(vm.pendingFiles, [newPending]);
  assert.deepEqual(vm.messageQueue, [{ text: 'new-thread follow-up', files: [newQueued] }]);

  vm._activateComposer(17);
  assert.equal(vm.input, 'thread 17 draft');
  assert.deepEqual(vm.pendingFiles, [threadPending]);
  assert.deepEqual(vm.messageQueue, [{ text: 'thread 17 follow-up', files: [] }]);
});

test('reload restores text but blocks automatic sending until each queued item is reviewed', async () => {
  const first = chatComponent();
  first._activateComposer(23);
  first.input = 'ordinary saved draft';
  first.messageQueue.push({ text: 'queued before reload', files: [] });
  first.unconfirmedSends['thread:23'] = 'delivery was not confirmed';
  first._saveCurrentComposer();

  const persisted = JSON.parse(globalThis.localStorage.getItem('chatComposerDraftsV1'));
  assert.deepEqual(persisted['thread:23'], {
    input: 'ordinary saved draft',
    queue: ['queued before reload'],
    recovery: 'delivery was not confirmed',
  });

  const restored = chatComponent();
  restored._loadPersistedComposers();
  restored._activateComposer(23);
  assert.equal(restored.input, 'ordinary saved draft');
  assert.deepEqual(restored.messageQueue.map((q) => q.text), [
    'delivery was not confirmed',
    'queued before reload',
  ]);
  assert.ok(restored.messageQueue.every((q) => q.restored === true));
  assert.ok(restored.messageQueue.every((q) => q.files.length === 0));

  restored.input = '';
  restored._saveCurrentComposer();
  let sends = 0;
  restored.send = async () => { sends += 1; };
  await restored._flushQueue();
  assert.equal(sends, 0);
  assert.equal(restored.messageQueue.length, 2);

  restored.reviewQueued(0);
  assert.equal(restored.input, 'delivery was not confirmed');
  assert.equal(restored.messageQueue.length, 1);
  assert.equal(sends, 0);
});

test('automatic queue flushing never overwrites a newer draft or its attachments', async () => {
  const vm = chatComponent();
  const draftFile = { name: 'newer-file', label: 'newer.txt' };
  vm.input = 'newer unsent draft';
  vm.pendingFiles = [draftFile];
  vm.messageQueue = [{ text: 'older queued follow-up', files: [] }];
  vm._saveCurrentComposer();
  let sends = 0;
  vm.send = async () => { sends += 1; };

  await vm._flushQueue();

  assert.equal(sends, 0);
  assert.equal(vm.input, 'newer unsent draft');
  assert.deepEqual(vm.pendingFiles, [draftFile]);
  assert.deepEqual(vm.messageQueue, [{ text: 'older queued follow-up', files: [] }]);
});

test('an upload finishing after a switch attaches only to its originating composer', async () => {
  const vm = chatComponent();
  let finishUpload;
  vm._authFetch = async () => new Promise((resolve) => { finishUpload = resolve; });

  const event = { target: { files: [{ name: 'late.txt' }], value: 'selected' } };
  const upload = vm.onFiles(event);
  vm._activateComposer(41);
  finishUpload({
    ok: true,
    async json() { return { name: 'stored-late.txt', size: 12 }; },
  });
  await upload;

  assert.deepEqual(vm.pendingFiles, []);
  assert.deepEqual(vm.composerStates.new.pendingFiles, [{
    name: 'stored-late.txt',
    size: 12,
    label: 'late.txt',
    previewUrl: null,
  }]);
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('chatUploadCleanupV1')), ['stored-late.txt']);
});

test('an accepted send removes its files from the reload cleanup ledger', () => {
  const vm = chatComponent();
  const accepted = { name: 'accepted-upload', label: 'accepted.txt' };
  const stillPending = { name: 'other-upload', label: 'other.txt' };
  vm._queueUploadCleanup([accepted, stillPending]);
  vm.unconfirmedSends.new = 'send me';
  vm.inFlightFiles = [accepted];

  vm._confirmAcceptedSend('new', [accepted]);

  assert.equal(vm.unconfirmedSends.new, undefined);
  assert.deepEqual(vm.inFlightFiles, []);
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('chatUploadCleanupV1')), ['other-upload']);
});

test('delete and unmount collect pending, queued, and unconfirmed upload files for cleanup', async () => {
  const deleted = chatComponent();
  const pending = { name: 'pending', label: 'pending.txt' };
  const queued = { name: 'queued', label: 'queued.txt' };
  deleted.composerStates['thread:9'] = {
    input: 'discard me',
    pendingFiles: [pending],
    messageQueue: [{ text: 'also discard', files: [queued] }],
  };
  deleted.unconfirmedSends['thread:9'] = 'uncertain';
  let deleteFiles = [];
  deleted._discardFiles = async (files) => { deleteFiles = files; };

  await deleted._dropComposer('thread:9');
  assert.deepEqual(deleteFiles, [pending, queued]);
  assert.equal(deleted.composerStates['thread:9'], undefined);
  assert.equal(deleted.unconfirmedSends['thread:9'], undefined);

  const unmounted = chatComponent();
  const newPending = { name: 'new-pending', label: 'new.txt' };
  const threadQueued = { name: 'thread-queued', label: 'thread.txt' };
  const inFlight = { name: 'unaccepted', label: 'unaccepted.txt' };
  unmounted.pendingFiles.push(newPending);
  unmounted._saveCurrentComposer();
  unmounted.composerStates['thread:4'] = {
    input: '',
    pendingFiles: [],
    messageQueue: [{ text: 'queued', files: [threadQueued] }],
  };
  unmounted.inFlightFiles = [inFlight];
  unmounted.messages = [{ _previews: ['blob:sent-preview'] }];
  let unmountFiles = [];
  let revokedMessages = null;
  unmounted._discardFiles = async (files) => { unmountFiles = files; };
  unmounted._revokeMessagePreviews = (messages) => { revokedMessages = messages; };

  ChatView.beforeUnmount.call(unmounted);

  assert.deepEqual(unmountFiles, [newPending, threadQueued, inFlight]);
  assert.equal(revokedMessages, unmounted.messages);
  assert.equal(unmounted._unmounted, true);
});
