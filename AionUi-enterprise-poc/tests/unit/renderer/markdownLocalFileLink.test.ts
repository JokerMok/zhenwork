import { isEnterpriseKnowledgeSourceLink, trustedArtifactLink } from '@/renderer/components/Markdown/markdownUtils';
/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

describe('trusted task artifact links', () => {
  const receipt = {
    path: '成果/真实.xlsx',
    versionId: 'version-a',
    sha256: 'a'.repeat(64),
    valid: true,
    downloadUrl: '/enterprise/files/download?path=real&version=version-a',
    previewUrl: '/#/workspace?section=files&previewPath=real&fileVersion=version-a',
  };
  it('uses only the Host URL for an exact pinned reference', () => {
    expect(
      trustedArtifactLink(
        '/enterprise/files/download?path=' + encodeURIComponent(receipt.path) + '&version=version-a',
        [receipt],
        'https://employee.test'
      )
    ).toEqual({ href: receipt.downloadUrl, download: true });
  });
  it('does not guess similar filenames, unknown versions or a different employee server', () => {
    expect(trustedArtifactLink('成果/写错.xlsx', [receipt], 'https://employee.test')).toBeNull();
    expect(
      trustedArtifactLink(
        '/enterprise/files/download?path=' + encodeURIComponent(receipt.path) + '&version=other',
        [receipt],
        'https://employee.test'
      )
    ).toBeNull();
    expect(
      trustedArtifactLink(
        'https://other.test/enterprise/files/download?path=' + encodeURIComponent(receipt.path),
        [receipt],
        'https://employee.test'
      )
    ).toBeNull();
  });
  it('keeps source web citations and refuses an ambiguous historical version', () => {
    expect(trustedArtifactLink('https://official.example/law', [receipt], 'https://employee.test')).toBeUndefined();
    expect(
      trustedArtifactLink(
        '/enterprise/files/download?path=' + encodeURIComponent(receipt.path),
        [receipt, { ...receipt, versionId: 'version-b' }],
        'https://employee.test'
      )
    ).toBeNull();
  });
});
import {
  resolveLocalFileLinkPath,
  resolveLocalFileLinkReference,
  toLocalFileHref,
} from '@/renderer/components/Markdown/markdownUtils';

describe('resolveLocalFileLinkPath', () => {
  it('recognizes Windows absolute paths emitted as root-relative markdown links', () => {
    expect(resolveLocalFileLinkPath('/C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx')).toBe(
      'C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx'
    );
  });

  it('recognizes encoded file URLs', () => {
    expect(resolveLocalFileLinkPath('file:///C:/Users/Administrator/%E7%9C%8B%E6%9D%BF.xlsx')).toBe(
      'C:/Users/Administrator/看板.xlsx'
    );
  });

  it('recognizes common POSIX absolute paths', () => {
    expect(resolveLocalFileLinkPath('/Users/demo/outputs/report.xlsx')).toBe('/Users/demo/outputs/report.xlsx');
  });

  it('recognizes file-like POSIX absolute paths outside common home and temp roots', () => {
    expect(resolveLocalFileLinkPath('/opt/aionui/outputs/report.xlsx')).toBe('/opt/aionui/outputs/report.xlsx');
  });

  it('recognizes line suffixes without confusing Windows drive letters', () => {
    const reference = resolveLocalFileLinkReference('C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421');

    expect(reference).toEqual({
      filePath: 'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log',
      rawReference: 'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421',
      line: 1421,
    });
    expect(resolveLocalFileLinkPath('C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421')).toBe(
      'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log'
    );
  });

  it('recognizes line and column suffixes without including the line in the file path', () => {
    const reference = resolveLocalFileLinkReference(
      'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421:7'
    );

    expect(reference).toEqual({
      filePath: 'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log',
      rawReference: 'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421:7',
      line: 1421,
      column: 7,
    });
    expect(resolveLocalFileLinkPath('C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421:7')).toBe(
      'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log'
    );
  });

  it('recognizes POSIX hash line references', () => {
    expect(resolveLocalFileLinkReference('/Users/demo/file.ts#L10')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L10',
      line: 10,
    });

    expect(resolveLocalFileLinkReference('/Users/demo/file.ts#L10-L20')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L10-L20',
      line: 10,
      endLine: 20,
    });
  });

  it('recognizes file URL hash line references and normalizes raw references', () => {
    expect(resolveLocalFileLinkReference('file:///Users/demo/file.ts#L10')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L10',
      line: 10,
    });

    expect(resolveLocalFileLinkReference('file:///Users/demo/file.ts#L10-L20')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L10-L20',
      line: 10,
      endLine: 20,
    });

    expect(resolveLocalFileLinkReference('file:///Users/demo/My%20File.ts#L10')).toEqual({
      filePath: '/Users/demo/My File.ts',
      rawReference: '/Users/demo/My File.ts#L10',
      line: 10,
    });

    expect(resolveLocalFileLinkReference('file:///Users/demo/%E6%96%87%E4%BB%B6.ts#L10')).toEqual({
      filePath: '/Users/demo/文件.ts',
      rawReference: '/Users/demo/文件.ts#L10',
      line: 10,
    });
  });

  it('recognizes Windows file URL hash lines and ranges', () => {
    expect(resolveLocalFileLinkReference('file:///C:/Users/demo/file.ts#L10')).toEqual({
      filePath: 'C:/Users/demo/file.ts',
      rawReference: 'C:/Users/demo/file.ts#L10',
      line: 10,
    });

    expect(resolveLocalFileLinkReference('file:///C:/Users/demo/file.ts#L10-L20')).toEqual({
      filePath: 'C:/Users/demo/file.ts',
      rawReference: 'C:/Users/demo/file.ts#L10-L20',
      line: 10,
      endLine: 20,
    });
  });

  it('prioritizes hash line references over colon suffixes', () => {
    expect(resolveLocalFileLinkReference('/Users/demo/file.ts:10#L20')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L20',
      line: 20,
    });
  });

  it('rejects unsupported hash line formats and remote hash links', () => {
    expect(resolveLocalFileLinkReference('user.ts')).toBeNull();
    expect(resolveLocalFileLinkReference('./user.ts')).toBeNull();
    expect(resolveLocalFileLinkReference('../user.ts')).toBeNull();
    expect(resolveLocalFileLinkReference('/settings')).toBeNull();
    expect(resolveLocalFileLinkReference('https://aionui.com/docs#L10')).toBeNull();
    expect(resolveLocalFileLinkReference('https://github.com/org/repo/blob/main/file.ts#L10')).toBeNull();
    expect(resolveLocalFileLinkReference('/Users/demo/file.ts#l10')).toBeNull();
    expect(resolveLocalFileLinkReference('/Users/demo/file.ts#L10-l20')).toBeNull();
  });

  it('does not treat normal web links or app routes as local files', () => {
    expect(resolveLocalFileLinkPath('https://aionui.com/docs')).toBeNull();
    expect(resolveLocalFileLinkPath('/settings')).toBeNull();
  });

  it('formats local file paths as file URLs for browser link copying', () => {
    expect(toLocalFileHref('C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx')).toBe(
      'file:///C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx'
    );
    expect(toLocalFileHref('/var/folders/demo/report.xlsx')).toBe('file:///var/folders/demo/report.xlsx');
  });
});

it('accepts only same-origin pinned knowledge links as normal application tabs', () => {
  const path = '/#/workspace?section=knowledge&documentId=11111111-1111-4111-8111-111111111111&version=2&chunk=3';
  expect(isEnterpriseKnowledgeSourceLink('https://work.example' + path, 'https://work.example')).toBe(true);
  expect(isEnterpriseKnowledgeSourceLink('https://other.example' + path, 'https://work.example')).toBe(false);
  expect(
    isEnterpriseKnowledgeSourceLink(
      'https://work.example' + path.replace('version=2', 'version=0'),
      'https://work.example'
    )
  ).toBe(false);
});
