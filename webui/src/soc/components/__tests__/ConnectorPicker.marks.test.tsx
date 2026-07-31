import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectorManifest } from '@/lib/types';
import { BUILTIN_CONNECTOR_SOURCE_TYPES } from '@/design-system';
import { ConnectorPicker } from '../ConnectorPicker';

const CATEGORY_BY_TYPE: Record<string, ConnectorManifest['category']> = {
  elasticsearch: 'siem',
  opensearch: 'siem',
  wazuh: 'edr_xdr',
  webhook: 'transport',
  hec: 'transport',
  syslog: 'transport',
  kafka: 'queue',
  aws_sqs: 'queue',
  aws_kinesis: 'queue',
  azure_event_hub: 'queue',
  gcp_pubsub: 'queue',
  rabbitmq: 'queue',
  nats: 'queue',
  mqtt: 'queue',
  redis_streams: 'queue',
  s3: 'object_store',
  gcs: 'object_store',
  azure_blob: 'object_store',
  file: 'file',
};

const connectors: ConnectorManifest[] = BUILTIN_CONNECTOR_SOURCE_TYPES.map((sourceType) => ({
  source_type: sourceType,
  display_name: sourceType.replaceAll('_', ' '),
  category: CATEGORY_BY_TYPE[sourceType],
  ingest_modes: [],
}));

describe('ConnectorPicker source identities', () => {
  it('uses one distinct custom mark for every built-in connector card', () => {
    const { container } = render(<ConnectorPicker connectors={connectors} onSelect={vi.fn()} />);

    const marks = Array.from(container.querySelectorAll<SVGElement>('[data-source-mark]'));
    expect(marks).toHaveLength(BUILTIN_CONNECTOR_SOURCE_TYPES.length);
    expect(new Set(marks.map((mark) => mark.dataset.sourceMark)).size).toBe(
      BUILTIN_CONNECTOR_SOURCE_TYPES.length,
    );
    expect(marks.every((mark) => mark.getAttribute('aria-hidden') === 'true')).toBe(true);
  });
});

