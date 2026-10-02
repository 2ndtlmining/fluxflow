import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from './config';

/** A minimal environment that passes validation, overridable per test. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...overrides };
}

const VALID_PRODUCTION_TOKEN = 'a'.repeat(32);

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(env());

    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.origin).toBeUndefined();
    expect(config.databasePath).toBe('./data/flux-flow.db');
    expect(config.dataSources.blockbookUrl).toBe('https://blockbook.runonflux.io');
    expect(config.sync.batchSize).toBe(250);
    expect(config.sync.retentionDays).toBe(180);
    expect(config.http.timeoutMs).toBe(15_000);
    expect(config.log.level).toBe('info');
  });

  it('coerces numeric strings', () => {
    const config = loadConfig(env({ PORT: '8080', SYNC_BATCH_SIZE: '500', RETENTION_DAYS: '90' }));

    expect(config.port).toBe(8080);
    expect(config.sync.batchSize).toBe(500);
    expect(config.sync.retentionDays).toBe(90);
  });

  it('reads the indexer URL from the environment instead of hard-coding it', () => {
    const config = loadConfig(env({ FLUX_INDEXER_URL: 'http://10.0.0.5:42067/' }));

    expect(config.dataSources.fluxIndexerUrl).toBe('http://10.0.0.5:42067');
    expect(config.hasDedicatedIndexer).toBe(true);
    expect(config.enhancementEnabled).toBe(true);
  });

  it('disables enhancement cleanly when no indexer is configured', () => {
    const config = loadConfig(env());

    expect(config.dataSources.fluxIndexerUrl).toBeUndefined();
    expect(config.hasDedicatedIndexer).toBe(false);
    expect(config.enhancementEnabled).toBe(false);
  });

  it('treats an empty variable as unset', () => {
    const config = loadConfig(env({ FLUX_INDEXER_URL: '   ', ADMIN_TOKEN: '' }));

    expect(config.dataSources.fluxIndexerUrl).toBeUndefined();
    expect(config.adminToken).toBeUndefined();
  });

  it('normalises trailing slashes on URLs', () => {
    const config = loadConfig(
      env({ BLOCKBOOK_URL: 'https://blockbook.runonflux.io///', ORIGIN: 'https://flux.example/' })
    );

    expect(config.dataSources.blockbookUrl).toBe('https://blockbook.runonflux.io');
    expect(config.origin).toBe('https://flux.example');
  });

  describe('boolean flags', () => {
    it.each([
      ['1', true],
      ['true', true],
      ['TRUE', true],
      ['yes', true],
      ['on', true],
      ['0', false],
      ['false', false],
      ['no', false],
      ['', false],
      ['anything', false]
    ])('reads %s as %s', (raw, expected) => {
      expect(loadConfig(env({ SYNC_ENABLED: raw })).syncEnabled).toBe(expected);
    });
  });

  it('rejects DEBUG_SQL in production rather than silently ignoring it', () => {
    // Fail loudly: an operator who turned SQL logging on in production has a problem
    // worth surfacing, not one worth quietly discarding.
    expect(() =>
      loadConfig(
        env({ NODE_ENV: 'production', DEBUG_SQL: '1', ADMIN_TOKEN: VALID_PRODUCTION_TOKEN })
      )
    ).toThrow(/DEBUG_SQL/);
  });

  it('never enables SQL logging outside an explicit opt-in', () => {
    expect(loadConfig(env()).debugSql).toBe(false);
    expect(loadConfig(env({ DEBUG_SQL: '0' })).debugSql).toBe(false);
    expect(loadConfig(env({ DEBUG_SQL: '1' })).debugSql).toBe(true);
  });

  it('forces structured JSON logs in production', () => {
    const config = loadConfig(
      env({ NODE_ENV: 'production', LOG_PRETTY: '1', ADMIN_TOKEN: VALID_PRODUCTION_TOKEN })
    );

    expect(config.log.pretty).toBe(false);
  });

  describe('validation failures', () => {
    it('rejects a non-numeric port', () => {
      expect(() => loadConfig(env({ PORT: 'not-a-port' }))).toThrow(ConfigError);
    });

    it('rejects an out-of-range port', () => {
      expect(() => loadConfig(env({ PORT: '70000' }))).toThrow(ConfigError);
    });

    it('rejects a malformed URL', () => {
      expect(() => loadConfig(env({ BLOCKBOOK_URL: 'not a url' }))).toThrow(ConfigError);
    });

    it('rejects an unknown log level', () => {
      expect(() => loadConfig(env({ LOG_LEVEL: 'chatty' }))).toThrow(ConfigError);
    });

    it('rejects an absurd batch size', () => {
      expect(() => loadConfig(env({ SYNC_BATCH_SIZE: '100000' }))).toThrow(ConfigError);
    });

    it('reports every problem at once rather than one per restart', () => {
      let issues: ConfigError | undefined;
      try {
        loadConfig(env({ PORT: 'nope', SYNC_BATCH_SIZE: '0' }));
      } catch (error) {
        issues = error as ConfigError;
      }

      expect(issues).toBeInstanceOf(ConfigError);
      expect(issues?.issues.length).toBeGreaterThanOrEqual(2);
      expect(issues?.message).toContain('PORT');
      expect(issues?.message).toContain('SYNC_BATCH_SIZE');
    });
  });

  describe('production guards', () => {
    it('requires ADMIN_TOKEN', () => {
      expect(() => loadConfig(env({ NODE_ENV: 'production' }))).toThrow(/ADMIN_TOKEN/);
    });

    it('rejects a short ADMIN_TOKEN', () => {
      expect(() => loadConfig(env({ NODE_ENV: 'production', ADMIN_TOKEN: 'short' }))).toThrow(
        /at least 32 characters/
      );
    });

    it('rejects DEBUG_SQL in production', () => {
      expect(() =>
        loadConfig(
          env({ NODE_ENV: 'production', DEBUG_SQL: '1', ADMIN_TOKEN: VALID_PRODUCTION_TOKEN })
        )
      ).toThrow(/DEBUG_SQL/);
    });

    it('accepts a valid production environment', () => {
      const config = loadConfig(
        env({ NODE_ENV: 'production', ADMIN_TOKEN: VALID_PRODUCTION_TOKEN })
      );

      expect(config.isProduction).toBe(true);
      expect(config.adminToken).toBe(VALID_PRODUCTION_TOKEN);
    });

    it('does not require ADMIN_TOKEN outside production', () => {
      expect(loadConfig(env()).adminToken).toBeUndefined();
    });
  });
});

describe('describeConfig', () => {
  it('never includes the admin token value', () => {
    const config = loadConfig(env({ NODE_ENV: 'production', ADMIN_TOKEN: VALID_PRODUCTION_TOKEN }));
    const described = describeConfig(config);

    expect(JSON.stringify(described)).not.toContain(VALID_PRODUCTION_TOKEN);
    expect(described.adminToken).toBe(`(set, ${VALID_PRODUCTION_TOKEN.length} chars)`);
  });

  it('reports an unset admin token without pretending it is configured', () => {
    expect(describeConfig(loadConfig(env())).adminToken).toBe('(not set)');
  });

  it('surfaces every setting the operator needs to sanity-check', () => {
    const described = describeConfig(loadConfig(env()));

    expect(described).toMatchObject({
      nodeEnv: 'test',
      listen: '0.0.0.0:3000',
      syncEnabled: true,
      enhancementEnabled: false
    });
    expect(described.dataSources).toMatchObject({ fluxIndexerUrl: '(not configured)' });
  });
});
