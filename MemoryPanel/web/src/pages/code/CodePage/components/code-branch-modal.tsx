/**
 * BranchSwitchModal —— 切换分支弹窗（列表与详情页共用）。
 * 无内部状态：目标分支 / 提交中状态与提交逻辑均由 useCodeSources 提供。
 */
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, Modal, Text } from 'tea-component';
import { formatRepoName, isValidGitBranchName } from './code-constants';
import type { CodeSourcesStore } from './useCodeSources';

export function BranchSwitchModal({ store }: { store: CodeSourcesStore }) {
  const { t } = useTranslation();
  const {
    branchTarget,
    formNewBranch,
    setFormNewBranch,
    switchingBranch,
    closeBranchModal,
    handleChangeBranch,
  } = store;

  if (!branchTarget) return null;

  const target = formNewBranch.trim();
  const valid = isValidGitBranchName(target);
  const same = target === branchTarget.branch;
  const repoLabel = formatRepoName(branchTarget.repo_name, branchTarget.repo_url);

  return (
    <Modal
      visible
      caption={t('code.branchSwitch.caption')}
      size="m"
      onClose={closeBranchModal}
      disableEscape={switchingBranch}
    >
      <Modal.Body>
        <Form>
          <Form.Item label={t('code.branchSwitch.repo')}>
            <Text className="_codedetail-mono">{repoLabel}</Text>
          </Form.Item>
          <Form.Item label={t('code.branchSwitch.current')}>
            <Input size="full" value={branchTarget.branch} onChange={() => undefined} disabled />
          </Form.Item>
          <Form.Item
            label={t('code.branchSwitch.target')}
            required
            extra={t('code.branchSwitch.hint')}
          >
            <Input
              size="full"
              value={formNewBranch}
              onChange={setFormNewBranch}
              placeholder={t('code.branchSwitch.placeholder')}
            />
          </Form.Item>
          {!!target && !valid && (
            <Form.Item>
              <Alert type="error">{t('code.branchSwitch.invalid')}</Alert>
            </Form.Item>
          )}
          {!!target && valid && same && (
            <Form.Item>
              <Alert type="info">{t('code.branchSwitch.same')}</Alert>
            </Form.Item>
          )}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          onClick={handleChangeBranch}
          disabled={switchingBranch || !valid || same}
          loading={switchingBranch}
        >
          {switchingBranch ? t('code.branchSwitch.submitting') : t('code.branchSwitch.submit')}
        </Button>
        <Button onClick={closeBranchModal} disabled={switchingBranch}>
          {t('common.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
