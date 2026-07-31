/**
 * Agentic SOC source-mark assets.
 *
 * These are original, single-colour vector marks drawn for the Console. They are
 * intentionally not downloaded vendor logos: every shape inherits `currentColor`,
 * so it remains legible under the operator's Light, Dark, or System theme and does
 * not introduce a trademark/licensing or remote-asset dependency.
 *
 * The geometry is plain serialisable data. A future agent-facing design catalog can
 * expose it without scraping JSX; no MCP/network service is implemented here.
 */

export type SourceMarkCategory =
  | 'siem'
  | 'edr_xdr'
  | 'transport'
  | 'queue'
  | 'object_store'
  | 'file'
  | 'generic';

export interface SourceMarkPath {
  d: string;
  fill?: boolean;
  opacity?: number;
  strokeWidth?: number;
}

export interface SourceMarkCircle {
  cx: number;
  cy: number;
  r: number;
  fill?: boolean;
  opacity?: number;
}

export interface SourceMarkRect {
  x: number;
  y: number;
  width: number;
  height: number;
  rx?: number;
  fill?: boolean;
  opacity?: number;
}

export interface SourceMarkLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  opacity?: number;
}

export interface SourceMarkDefinition {
  /** Stable machine-facing asset id. */
  id: string;
  /** Wire-compatible source type. */
  sourceType: string;
  /** Accessible human name for the custom mark. */
  label: string;
  category: SourceMarkCategory;
  paths?: readonly SourceMarkPath[];
  circles?: readonly SourceMarkCircle[];
  rects?: readonly SourceMarkRect[];
  lines?: readonly SourceMarkLine[];
}

/** The nineteen connector types registered by the built-in runtime today. */
export const BUILTIN_CONNECTOR_SOURCE_TYPES = [
  'elasticsearch',
  'opensearch',
  'wazuh',
  'webhook',
  'hec',
  'syslog',
  'kafka',
  'aws_sqs',
  'aws_kinesis',
  'azure_event_hub',
  'gcp_pubsub',
  'rabbitmq',
  'nats',
  'mqtt',
  'redis_streams',
  's3',
  'gcs',
  'azure_blob',
  'file',
] as const;

/**
 * Complete core SourceType catalog, including reserved native connectors. The
 * reserved marks make future connector activation visually stable on day one.
 */
export const SOURCE_MARK_CATALOG: readonly SourceMarkDefinition[] = [
  {
    id: 'source.elasticsearch.segmented-orbit',
    sourceType: 'elasticsearch',
    label: 'Elasticsearch source',
    category: 'siem',
    paths: [
      { d: 'M6.4 6.5a7 7 0 0 1 10.2-.8' },
      { d: 'M5 10.1h9.3a3.7 3.7 0 0 1 3.5 2.5' },
      { d: 'M6.2 16.9a7 7 0 0 0 10.5.8' },
    ],
    circles: [{ cx: 5.2, cy: 12, r: 1.2, fill: true }],
  },
  {
    id: 'source.opensearch.lens-orbit',
    sourceType: 'opensearch',
    label: 'OpenSearch source',
    category: 'siem',
    paths: [
      { d: 'M15.8 15.8 20 20' },
      { d: 'M7.2 8.4a6 6 0 1 1-.6 6.2' },
      { d: 'M8.5 7.7a4.1 4.1 0 0 1 5.7-.1' },
    ],
  },
  {
    id: 'source.splunk.forward-chevrons',
    sourceType: 'splunk',
    label: 'Splunk source',
    category: 'siem',
    paths: [
      { d: 'm5 7 5 5-5 5' },
      { d: 'm11 7 5 5-5 5' },
      { d: 'M17 17h2' },
    ],
  },
  {
    id: 'source.sentinel.window-shield',
    sourceType: 'sentinel',
    label: 'Microsoft Sentinel source',
    category: 'siem',
    paths: [
      { d: 'M4 5.5 11 4v7H4z' },
      { d: 'M13 3.6 20 2v9h-7z' },
      { d: 'M4 13h7v7l-7-1.5z' },
      { d: 'M13 13h7v9l-7-1.6z' },
    ],
  },
  {
    id: 'source.qradar.quadrant-radar',
    sourceType: 'qradar',
    label: 'QRadar source',
    category: 'siem',
    paths: [
      { d: 'M12 4a8 8 0 1 0 8 8' },
      { d: 'M12 8a4 4 0 1 0 4 4' },
      { d: 'M12 12 18.5 5.5' },
    ],
    circles: [{ cx: 12, cy: 12, r: 1.1, fill: true }],
  },
  {
    id: 'source.chronicle.time-rings',
    sourceType: 'chronicle',
    label: 'Chronicle source',
    category: 'siem',
    circles: [
      { cx: 12, cy: 12, r: 7.8 },
      { cx: 12, cy: 12, r: 4.2 },
      { cx: 12, cy: 12, r: 1.1, fill: true },
    ],
    lines: [
      { x1: 12, y1: 4.2, x2: 12, y2: 7.8 },
      { x1: 16.2, y1: 12, x2: 19.8, y2: 12 },
    ],
  },
  {
    id: 'source.crowdstrike.falcon-wing',
    sourceType: 'crowdstrike',
    label: 'CrowdStrike source',
    category: 'edr_xdr',
    paths: [
      { d: 'M3.5 15.8c4.7-5.7 8.8-8.4 17-10.1-3.4 2.2-5.8 4.2-7.5 6.2' },
      { d: 'M4.4 18.5c4.4-3.7 7.5-5 13.4-5.5-3.4 1.4-5.5 3-7.2 5.5' },
    ],
  },
  {
    id: 'source.sentinelone.single-sentinel',
    sourceType: 'sentinelone',
    label: 'SentinelOne source',
    category: 'edr_xdr',
    paths: [
      { d: 'M12 3.5 19 7.4v9.2L12 20.5 5 16.6V7.4z' },
      { d: 'M9 9.2h4.1a2.1 2.1 0 0 1 0 4.2H11a2.1 2.1 0 0 0 0 4.2h4' },
    ],
  },
  {
    id: 'source.defender.guard-window',
    sourceType: 'defender',
    label: 'Microsoft Defender source',
    category: 'edr_xdr',
    paths: [
      { d: 'M12 3 19 6v5.3c0 4.3-2.5 7.3-7 9.7-4.5-2.4-7-5.4-7-9.7V6z' },
      { d: 'M12 6v12' },
      { d: 'M7.2 9.5H12' },
    ],
  },
  {
    id: 'source.wazuh.triad-shield',
    sourceType: 'wazuh',
    label: 'Wazuh source',
    category: 'edr_xdr',
    paths: [
      { d: 'M12 3 20 6.5v5.2c0 4.3-2.8 7.3-8 9.3-5.2-2-8-5-8-9.3V6.5z' },
      { d: 'm8 9 2 6 2-4 2 4 2-6' },
    ],
  },
  {
    id: 'source.webhook.link-orbit',
    sourceType: 'webhook',
    label: 'Webhook source',
    category: 'transport',
    paths: [
      { d: 'M8.2 7.2a4 4 0 0 1 6.6 1l1 1' },
      { d: 'M15.8 16.8a4 4 0 0 1-6.6-1l-1-1' },
      { d: 'm9.2 14.8 5.6-5.6' },
    ],
    circles: [
      { cx: 6.2, cy: 6.2, r: 1.4 },
      { cx: 17.8, cy: 17.8, r: 1.4 },
    ],
  },
  {
    id: 'source.hec.collector-gate',
    sourceType: 'hec',
    label: 'HTTP Event Collector source',
    category: 'transport',
    paths: [
      { d: 'M5 5v14' },
      { d: 'M19 5v14' },
      { d: 'm8 8 4 4-4 4' },
      { d: 'M12 12h4' },
    ],
  },
  {
    id: 'source.syslog.terminal-stream',
    sourceType: 'syslog',
    label: 'Syslog source',
    category: 'transport',
    rects: [{ x: 3.5, y: 5, width: 17, height: 14, rx: 2 }],
    paths: [
      { d: 'm7 9 3 3-3 3' },
      { d: 'M12 15h5' },
    ],
  },
  {
    id: 'source.beats.beat-pulse',
    sourceType: 'beats',
    label: 'Elastic Beats source',
    category: 'transport',
    paths: [
      { d: 'M3 12h4l2-5 3 10 2-5h7' },
      { d: 'M5 5.5h14' },
      { d: 'M5 18.5h14' },
    ],
  },
  {
    id: 'source.fluentd.fluid-diamond',
    sourceType: 'fluentd',
    label: 'Fluentd source',
    category: 'transport',
    paths: [
      { d: 'M12 3 20 10.5 12 21 4 10.5z' },
      { d: 'M7.5 10.5 12 15l4.5-4.5L12 6z' },
    ],
  },
  {
    id: 'source.otlp.telemetry-span',
    sourceType: 'otlp',
    label: 'OpenTelemetry source',
    category: 'transport',
    circles: [
      { cx: 5, cy: 12, r: 1.4, fill: true },
      { cx: 12, cy: 6, r: 1.4, fill: true },
      { cx: 19, cy: 12, r: 1.4, fill: true },
      { cx: 12, cy: 18, r: 1.4, fill: true },
    ],
    paths: [{ d: 'm6.4 10.8 4.2-3.6m2.8 0 4.2 3.6m0 2.4-4.2 3.6m-2.8 0-4.2-3.6' }],
  },
  {
    id: 'source.kafka.partition-stream',
    sourceType: 'kafka',
    label: 'Kafka source',
    category: 'queue',
    lines: [
      { x1: 12, y1: 4, x2: 12, y2: 20 },
      { x1: 12, y1: 8, x2: 6, y2: 5 },
      { x1: 12, y1: 8, x2: 18, y2: 5 },
      { x1: 12, y1: 16, x2: 6, y2: 19 },
      { x1: 12, y1: 16, x2: 18, y2: 19 },
    ],
    circles: [
      { cx: 12, cy: 4, r: 1.3 },
      { cx: 12, cy: 12, r: 1.3 },
      { cx: 12, cy: 20, r: 1.3 },
      { cx: 6, cy: 5, r: 1.3 },
      { cx: 18, cy: 5, r: 1.3 },
      { cx: 6, cy: 19, r: 1.3 },
      { cx: 18, cy: 19, r: 1.3 },
    ],
  },
  {
    id: 'source.pulsar.pulse-rings',
    sourceType: 'pulsar',
    label: 'Apache Pulsar source',
    category: 'queue',
    paths: [
      { d: 'M5 8.5c3.4-3.4 10.6-3.4 14 0' },
      { d: 'M7 12c2.4-2.3 7.6-2.3 10 0' },
      { d: 'M9.5 15.5a3.6 3.6 0 0 1 5 0' },
    ],
    circles: [{ cx: 12, cy: 19, r: 1.2, fill: true }],
  },
  {
    id: 'source.rabbitmq.rabbit-route',
    sourceType: 'rabbitmq',
    label: 'RabbitMQ source',
    category: 'queue',
    paths: [
      { d: 'M7 10V4.5M11 10V3.5M7 10c-2 1.2-3 3-3 5.2V19h11.5l4.5-4.5-3-3H13' },
      { d: 'M8 15h4' },
    ],
    circles: [{ cx: 15.2, cy: 8.2, r: 1.1, fill: true }],
  },
  {
    id: 'source.nats.jet-burst',
    sourceType: 'nats',
    label: 'NATS source',
    category: 'queue',
    paths: [
      { d: 'M4 17 8 7l4 10 4-10 4 10' },
      { d: 'M7 20h10' },
    ],
  },
  {
    id: 'source.mqtt.packet-signal',
    sourceType: 'mqtt',
    label: 'MQTT source',
    category: 'queue',
    paths: [
      { d: 'M5 18a13 13 0 0 1 13-13' },
      { d: 'M5 13a8 8 0 0 1 8-8' },
      { d: 'M5 8a3 3 0 0 1 3-3' },
      { d: 'M5 18h4v-4H5z' },
    ],
  },
  {
    id: 'source.redis_streams.layered-stream',
    sourceType: 'redis_streams',
    label: 'Redis Streams source',
    category: 'queue',
    paths: [
      { d: 'm4 8 8-4 8 4-8 4z' },
      { d: 'm4 12 8 4 8-4' },
      { d: 'm4 16 8 4 8-4' },
    ],
  },
  {
    id: 'source.aws_sqs.queued-brackets',
    sourceType: 'aws_sqs',
    label: 'Amazon SQS source',
    category: 'queue',
    paths: [
      { d: 'M5 5H3v14h2' },
      { d: 'M19 5h2v14h-2' },
      { d: 'M7 8h10M7 12h7M7 16h10' },
    ],
    circles: [{ cx: 17, cy: 12, r: 1, fill: true }],
  },
  {
    id: 'source.aws_kinesis.converging-streams',
    sourceType: 'aws_kinesis',
    label: 'Amazon Kinesis source',
    category: 'queue',
    paths: [
      { d: 'M4 6c5 0 5 6 10 6h6' },
      { d: 'M4 12h5' },
      { d: 'M4 18c5 0 5-6 10-6' },
      { d: 'm17 9 3 3-3 3' },
    ],
  },
  {
    id: 'source.azure_event_hub.radial-hub',
    sourceType: 'azure_event_hub',
    label: 'Azure Event Hubs source',
    category: 'queue',
    circles: [{ cx: 12, cy: 12, r: 3.2 }],
    paths: [
      { d: 'M4 8c2.5-4 5.5-5.5 8-5.5M4 16c2.5 4 5.5 5.5 8 5.5' },
      { d: 'M20 8c-2.5-4-5.5-5.5-8-5.5M20 16c-2.5 4-5.5 5.5-8 5.5' },
    ],
  },
  {
    id: 'source.gcp_pubsub.publish-grid',
    sourceType: 'gcp_pubsub',
    label: 'Google Cloud Pub/Sub source',
    category: 'queue',
    rects: [{ x: 9, y: 9, width: 6, height: 6, rx: 1 }],
    circles: [
      { cx: 5, cy: 5, r: 1.5 },
      { cx: 19, cy: 5, r: 1.5 },
      { cx: 5, cy: 19, r: 1.5 },
      { cx: 19, cy: 19, r: 1.5 },
    ],
    lines: [
      { x1: 6.1, y1: 6.1, x2: 9.2, y2: 9.2 },
      { x1: 17.9, y1: 6.1, x2: 14.8, y2: 9.2 },
      { x1: 6.1, y1: 17.9, x2: 9.2, y2: 14.8 },
      { x1: 17.9, y1: 17.9, x2: 14.8, y2: 14.8 },
    ],
  },
  {
    id: 'source.s3.object-bucket',
    sourceType: 's3',
    label: 'Amazon S3 source',
    category: 'object_store',
    paths: [
      { d: 'M5 7c0-2 14-2 14 0v10c0 2-14 2-14 0z' },
      { d: 'M5 7c0 2 14 2 14 0' },
      { d: 'M5 12c0 2 14 2 14 0' },
    ],
  },
  {
    id: 'source.gcs.cloud-object',
    sourceType: 'gcs',
    label: 'Google Cloud Storage source',
    category: 'object_store',
    paths: [
      { d: 'M7 17.5h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.3 8.4 4.6 4.6 0 0 0 7 17.5z' },
      { d: 'M9 12h6M9 15h4' },
    ],
  },
  {
    id: 'source.azure_blob.faceted-drop',
    sourceType: 'azure_blob',
    label: 'Azure Blob Storage source',
    category: 'object_store',
    paths: [
      { d: 'M12 3c4.2 5.1 6.3 8.8 6.3 11.1a6.3 6.3 0 0 1-12.6 0C5.7 11.8 7.8 8.1 12 3z' },
      { d: 'M8.2 15.5 12 12l3.8 3.5' },
    ],
  },
  {
    id: 'source.file.document-flow',
    sourceType: 'file',
    label: 'File source',
    category: 'file',
    paths: [
      { d: 'M6 3h8l4 4v14H6z' },
      { d: 'M14 3v5h5' },
      { d: 'M9 12h6M9 16h6' },
    ],
  },
  {
    id: 'source.generic.connected-grid',
    sourceType: 'generic',
    label: 'Generic source',
    category: 'generic',
    rects: [
      { x: 4, y: 4, width: 5, height: 5, rx: 1 },
      { x: 15, y: 4, width: 5, height: 5, rx: 1 },
      { x: 9.5, y: 15, width: 5, height: 5, rx: 1 },
    ],
    lines: [
      { x1: 9, y1: 7, x2: 15, y2: 7 },
      { x1: 7, y1: 9, x2: 11.5, y2: 15 },
      { x1: 17, y1: 9, x2: 12.5, y2: 15 },
    ],
  },
] as const;

export const SOURCE_MARK_BY_TYPE = new Map(
  SOURCE_MARK_CATALOG.map((definition) => [definition.sourceType, definition] as const),
);

export const FALLBACK_SOURCE_MARK = SOURCE_MARK_BY_TYPE.get('generic')!;

