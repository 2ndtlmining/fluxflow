// Background Enhancement Service - PHASE 4
// Continuously analyzes unknown wallets in the background

import { FLUX_CONFIG } from '../config.js';

class BackgroundEnhancementService {
  constructor(databaseService, enhancementService) {
    this.db = databaseService;
    this.enhancer = enhancementService;
    this.isRunning = false;
    this.timer = null;
    this.lastEnhancementTime = 0;
    this.totalEnhanced = 0;
    
    // Get interval from config (convert minutes to ms)
    this.interval = FLUX_CONFIG.ENHANCEMENT.BACKGROUND_JOB.INTERVAL_MINUTES * 60 * 1000;
    
    console.log('🤖 BackgroundEnhancementService initialized');
    console.log(`   Interval: ${FLUX_CONFIG.ENHANCEMENT.BACKGROUND_JOB.INTERVAL_MINUTES} minutes`);
  }

  /**
   * Start the background enhancement job
   */
  start() {
    if (this.isRunning) {
      console.log('⚠️  Background enhancement already running');
      return;
    }

    if (!FLUX_CONFIG.ENHANCEMENT.BACKGROUND_JOB.ENABLED) {
      console.log('ℹ️  Background enhancement disabled in config');
      return;
    }

    this.isRunning = true;
    console.log('🤖 Background enhancement service started');
    console.log(`   Will run every ${FLUX_CONFIG.ENHANCEMENT.BACKGROUND_JOB.INTERVAL_MINUTES} minutes\n`);

    // Run immediately on start if configured
    if (FLUX_CONFIG.ENHANCEMENT.BACKGROUND_JOB.RUN_ON_START) {
      setTimeout(() => this.runEnhancement(), 5000); // 5 second delay to let sync start first
    }

    // Schedule periodic runs
    this.timer = setInterval(() => {
      this.runEnhancement();
    }, this.interval);
  }

  /**
   * Stop the background enhancement job
   */
  stop() {
    if (!this.isRunning) {
      console.log('⚠️  Background enhancement not running');
      return;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.isRunning = false;
    console.log('🤖 Background enhancement service stopped');
  }

  /**
   * Run enhancement cycle
   */
  async runEnhancement() {
    // Skip if already enhancing
    if (this.enhancer.isEnhancementRunning()) {
      console.log('🤖 Skip: Enhancement already in progress');
      return;
    }

    try {
      const now = Date.now();
      const timeSinceLastRun = (now - this.lastEnhancementTime) / 1000 / 60; // minutes

      console.log(`\n${'='.repeat(70)}`);
      console.log('🤖 Background Enhancement Cycle');
      console.log(`   Time: ${new Date().toISOString()}`);
      console.log(`   Last run: ${timeSinceLastRun.toFixed(1)} minutes ago`);
      console.log('='.repeat(70));

      // Check for unknowns
      const unknowns = this.db.getUnknownWallets();
      const totalUnknowns = unknowns.total;

      console.log(`\n📊 Unknown wallets: ${totalUnknowns}`);
      console.log(`   Buying: ${unknowns.buys.length}`);
      console.log(`   Selling: ${unknowns.sells.length}`);

      if (totalUnknowns === 0) {
        console.log('✓ No unknowns to enhance\n');
        this.lastEnhancementTime = now;
        return;
      }

      // Check minimum threshold
      const minThreshold = FLUX_CONFIG.ENHANCEMENT.BACKGROUND_JOB.MIN_UNKNOWNS_THRESHOLD;
      if (totalUnknowns < minThreshold) {
        console.log(`ℹ️  Only ${totalUnknowns} unknowns (threshold: ${minThreshold})`);
        console.log('   Skipping enhancement to save resources\n');
        this.lastEnhancementTime = now;
        return;
      }

      console.log('\n🔍 Running enhancement...\n');

      // Run enhancement
      const result = await this.enhancer.enhanceUnknownWallets();

      if (result.success) {
        const enhanced = result.stats.enhanced.level1 + 
                        result.stats.enhanced.level2 + 
                        result.stats.enhanced.level3;
        
        this.totalEnhanced += enhanced;

        console.log('\n✅ Background enhancement complete');
        console.log(`   Enhanced this cycle: ${enhanced}`);
        console.log(`   Total enhanced (lifetime): ${this.totalEnhanced}`);
        console.log(`   Remaining unknowns: ${result.stats.remainedUnknown}\n`);
      } else {
        console.error('❌ Background enhancement failed:', result.message);
      }

      this.lastEnhancementTime = now;

    } catch (error) {
      console.error('❌ Background enhancement error:', error.message);
      console.error(error);
    }
  }

  /**
   * Get service status
   */
  getStatus() {
    const now = Date.now();
    const timeSinceLastRun = this.lastEnhancementTime > 0 
      ? Math.floor((now - this.lastEnhancementTime) / 1000 / 60) 
      : null;

    return {
      isRunning: this.isRunning,
      enabled: FLUX_CONFIG.ENHANCEMENT.BACKGROUND_JOB.ENABLED,
      intervalMinutes: FLUX_CONFIG.ENHANCEMENT.BACKGROUND_JOB.INTERVAL_MINUTES,
      lastRunMinutesAgo: timeSinceLastRun,
      lastRunTime: this.lastEnhancementTime > 0 ? new Date(this.lastEnhancementTime).toISOString() : null,
      totalEnhanced: this.totalEnhanced,
      isEnhancing: this.enhancer.isEnhancementRunning()
    };
  }

  /**
   * Manually trigger an enhancement run
   */
  async triggerManualRun() {
    if (this.enhancer.isEnhancementRunning()) {
      return {
        success: false,
        message: 'Enhancement already in progress'
      };
    }

    console.log('🤖 Manual enhancement triggered');
    await this.runEnhancement();
    
    return {
      success: true,
      message: 'Manual enhancement completed'
    };
  }
}

export default BackgroundEnhancementService;