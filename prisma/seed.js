import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

function hashSeedPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derivedKey}`;
}

async function main() {
  console.log('Seeding PostgreSQL db_sevaniq...');
  const adminUsername = (process.env.ADMIN_USERNAME || 'pungkyrama').trim();
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@sevaniq.enterprise').trim();
  const adminPassword = (process.env.ADMIN_PASSWORD || process.env.SEED_ADMIN_PASSWORD || '').trim();

  if (!adminPassword) {
    throw new Error(
      'ADMIN_PASSWORD or SEED_ADMIN_PASSWORD environment variable is required to seed the Super Admin safely.',
    );
  }

  // 1. Seed Super Admin User (Salted scrypt hash, never hardcoded plaintext)
  const admin = await prisma.user.upsert({
    where: { username: adminUsername },
    update: {
      email: adminEmail,
      passwordHash: hashSeedPassword(adminPassword),
      role: 'SUPER_ADMIN',
    },
    create: {
      id: 'usr-admin-01',
      username: adminUsername,
      email: adminEmail,
      phone: '+1-555-019-0000',
      passwordHash: hashSeedPassword(adminPassword),
      fullName: 'Pungky Rama (Admin)',
      role: 'SUPER_ADMIN',
    },
  });

  await prisma.platformFounderProfile.upsert({
    where: { userId: admin.id },
    update: {
      systemTitle: 'Platform Founder & System Sovereign',
      crownBadge: 'GOLD_CROWN_PLATFORM_SOVEREIGN',
    },
    create: {
      userId: admin.id,
      systemTitle: 'Platform Founder & System Sovereign',
      crownBadge: 'GOLD_CROWN_PLATFORM_SOVEREIGN',
    },
  });

  // 2. Seed Knowledge Base Article (no regular user accounts created by default)
  const existingKB = await prisma.knowledgeArticle.findFirst();
  if (!existingKB) {
    await prisma.knowledgeArticle.create({
      data: {
        title: 'Sevaniq Refund & Dispute Policy (Standard Operating Procedure)',
        category: 'Billing',
        tags: ['refund', 'billing', 'policy'],
        content:
          'Section 3.2: Duplicate charges resulting from network idempotency retries must be refunded immediately to the original payment method upon customer notification without requiring merchant return fees.',
      },
    });
  }

  // Optional demo user & tickets only when SEED_DEMO_DATA=true
  if (process.env.SEED_DEMO_DATA === 'true') {
    const demoCustomerPassword =
      process.env.SEED_DEMO_PASSWORD || crypto.randomBytes(16).toString('hex');
    const customer = await prisma.user.upsert({
      where: { email: 'customer.demo@sevaniq.local' },
      update: {},
      create: {
        id: 'usr-cust-01',
        username: 'demo_customer',
        email: 'customer.demo@sevaniq.local',
        phone: '+1-555-010-0000',
        passwordHash: hashSeedPassword(demoCustomerPassword),
        fullName: 'Alex Morgan (Customer)',
        role: 'CUSTOMER',
      },
    });

    await prisma.ticket.upsert({
      where: { ticketNumber: 1001 },
      update: {},
      create: {
        id: 'tick-001',
        ticketNumber: 1001,
        title: 'Payment processed twice for annual subscription',
        description:
          'I clicked upgrade once, but my bank statement shows two identical charges of $1,200 on Oct 30. Please refund the duplicate immediately.',
        status: 'OPEN',
        priority: 'CRITICAL',
        sentiment: 'FRUSTRATED',
        tags: ['billing', 'duplicate-charge', 'refund'],
        customerId: customer.id,
        assignedAgentId: admin.id,
      },
    });
  }

  console.log('Seeding completed successfully in db_sevaniq (Super Admin ready)!');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
