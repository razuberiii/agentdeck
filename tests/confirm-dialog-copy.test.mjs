import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8');

test('account delete confirmation uses the shared provider-neutral copy', () => {
  const helperBlock = source.slice(
    source.indexOf('function deleteAccountDetail'),
    source.indexOf('function cancelLoginDetail')
  );
  assert.match(helperBlock, /将删除该账户在本机保存的登录凭据/);
  assert.match(helperBlock, /历史会话和消息不会删除/);
  assert.match(helperBlock, /删除后该 Agent 将处于未登录状态/);
  assert.doesNotMatch(helperBlock, /Gemini 进程/);
  assert.doesNotMatch(helperBlock, /有历史会话引用时会从账户列表隐藏/);
  assert.doesNotMatch(helperBlock, /Codex Account/);
});

test('login-attempt cancellation uses continue-login and cancel-login actions', () => {
  const confirmBlock = source.slice(
    source.indexOf('{deleteProfile&&<ConfirmDialog'),
    source.indexOf('function mergeSettingsData')
  );
  assert.match(confirmBlock, /title=\{deleteProfile\.isLoginAttempt\?'取消登录？':'删除 Codex 账户？'\}/);
  assert.match(confirmBlock, /title=\{deleteGeminiProfile\.isLoginAttempt\?'取消登录？':'删除 Gemini 账户？'\}/);
  assert.match(confirmBlock, /title="删除 Antigravity 账户？"/);
  assert.match(confirmBlock, /cancel=\{deleteProfile\.isLoginAttempt\?'继续登录':'取消'\}/);
  assert.match(confirmBlock, /confirm=\{deleteProfile\.isLoginAttempt\?'取消登录':'删除账户'\}/);
  assert.match(confirmBlock, /cancel=\{deleteGeminiProfile\.isLoginAttempt\?'继续登录':'取消'\}/);
  assert.match(confirmBlock, /confirm=\{deleteGeminiProfile\.isLoginAttempt\?'取消登录':'删除账户'\}/);
  assert.match(confirmBlock, /confirm="删除账户"/);
});

test('ConfirmDialog locks background scroll and is responsive above the sheet', () => {
  const dialogBlock = source.slice(
    source.indexOf('function ConfirmDialog'),
    source.indexOf('function InlineNotice')
  );
  assert.match(dialogBlock, /document\.body\.style\.overflow='hidden'/);
  assert.match(dialogBlock, /cancel='取消'/);
  assert.match(styles, /\.dialogBackdrop\{[^}]*z-index:120/);
  assert.match(styles, /\.dialog\{[^}]*width:calc\(100vw - 32px\)/);
  assert.match(styles, /\.dialog\{[^}]*max-width:480px/);
  assert.match(styles, /\.dialog p\{[^}]*word-break:normal/);
  assert.match(styles, /\.dialog button\{[^}]*white-space:nowrap/);
  assert.match(styles, /@media\(max-width:320px\)\{\.dialog div\{grid-template-columns:1fr\}\}/);
});
