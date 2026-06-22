import { schema, TypeOf } from '@kbn/config-schema';

export const configSchema = schema.object({
  backendUrl: schema.string({ defaultValue: 'http://tlsoc-backend:8088' }),
});

export type TlsocConfig = TypeOf<typeof configSchema>;
