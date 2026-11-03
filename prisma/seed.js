import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding PostgreSQL db_sentrix...');

  // 1. Seed Admin User
  const admin = await prisma.user.upsert({
    where: { email: 'admin@sentrix.enterprise' },
    update: {},
    create: {
      id: 'usr-admin-01',
      username: 'pungkyrama',
      email: 'admin@sentrix.enterprise',
      phone: '+1-555-019-0000',
      passwordHash: '992bc7c5c6b8ada8493d7dd4068f16ac6da6c4bca14c363825c8df2b5f12a645',
      fullName: 'Pungky Rama (Admin)',
      role: 'ADMIN',
    },
  });

  // 2. Seed Customer User
  const customer = await prisma.user.upsert({
    where: { email: 'pungkyrama@gmail.com' },
    update: {},
    create: {
      id: 'usr-cust-01',
      username: 'shopee_ku',
      email: 'pungkyrama@gmail.com',
      phone: '081225575719',
      passwordHash: '992bc7c5c6b8ada8493d7dd4068f16ac6da6c4bca14c363825c8df2b5f12a645',
      fullName: 'Shopee Ku (Customer)',
      role: 'CUSTOMER',
    },
  });

  // 3. Seed Demo Tickets
  const ticket1 = await prisma.ticket.upsert({
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

  const ticket2 = await prisma.ticket.upsert({
    where: { ticketNumber: 1002 },
    update: {},
    create: {
      id: 'tick-002',
      ticketNumber: 1002,
      title: 'Webhooks failing with 504 Gateway Timeout',
      description:
        'Our webhook endpoint is not receiving customer.created events since 09:00 AM UTC. We see retries timing out.',
      status: 'NEW',
      priority: 'HIGH',
      sentiment: 'URGENT',
      tags: ['api', 'webhook', 'timeout'],
      customerId: customer.id,
    },
  });

  const ticket3 = await prisma.ticket.upsert({
    where: { ticketNumber: 1003 },
    update: {
      title:
        '[VIP Escalation] SLA Breach Warning: Enterprise Penalty Credit & Contract Renewal Review',
      description:
        'Yesterday, our peak checkout experienced an unscheduled outage of 45 minutes, exceeding our 99.9% uptime SLA agreement. As a Tier-1 Enterprise account ($180k ARR), I am escalating this directly to your Support Team Lead to discuss SLA penalty credit compensation and infrastructure stability guarantees before our executive board finalizes next week\'s annual contract renewal.',
      status: 'PENDING',
      priority: 'HIGH',
      sentiment: 'URGENT',
      tags: ['vip-escalation', 'sla-breach', 'contract-renewal', 'tier1-client'],
    },
    create: {
      id: 'tick-003',
      ticketNumber: 1003,
      title:
        '[VIP Escalation] SLA Breach Warning: Enterprise Penalty Credit & Contract Renewal Review',
      description:
        'Yesterday, our peak checkout experienced an unscheduled outage of 45 minutes, exceeding our 99.9% uptime SLA agreement. As a Tier-1 Enterprise account ($180k ARR), I am escalating this directly to your Support Team Lead to discuss SLA penalty credit compensation and infrastructure stability guarantees before our executive board finalizes next week\'s annual contract renewal.',
      status: 'PENDING',
      priority: 'HIGH',
      sentiment: 'URGENT',
      tags: ['vip-escalation', 'sla-breach', 'contract-renewal', 'tier1-client'],
      customerId: customer.id,
      assignedAgentId: admin.id,
    },
  });

  // 4. Seed Messages for Ticket 1
  const existingMsg = await prisma.message.findFirst({ where: { ticketId: ticket1.id } });
  if (!existingMsg) {
    await prisma.message.createMany({
      data: [
        {
          ticketId: ticket1.id,
          senderId: customer.id,
          type: 'PUBLIC_REPLY',
          content:
            'I clicked upgrade once, but my bank statement shows two identical charges of $1,200 on Oct 30. Please refund the duplicate immediately.',
          aiGenerated: false,
        },
        {
          ticketId: ticket1.id,
          senderId: admin.id,
          type: 'INTERNAL_NOTE',
          content:
            'Stripe charge ID ch_3Pq9 indicates a double webhook trigger from our checkout form. Verified on Stripe dashboard. Need finance approval for manual void.',
          aiGenerated: false,
        },
        {
          ticketId: ticket1.id,
          senderId: admin.id,
          type: 'PUBLIC_REPLY',
          content:
            'Hi Sarah, thanks for alerting us. I verified the duplicate charge and escalated it to our billing team. The second $1,200 is being reversed right now.',
          aiGenerated: true,
        },
      ],
    });
  }

  // 5. Seed Knowledge Base Article
  const existingKB = await prisma.knowledgeArticle.findFirst();
  if (!existingKB) {
    await prisma.knowledgeArticle.create({
      data: {
        title: 'Sentrix Refund & Dispute Policy (Standard Operating Procedure)',
        category: 'Billing',
        tags: ['refund', 'billing', 'policy'],
        content:
          'Section 3.2: Duplicate charges resulting from network idempotency retries must be refunded immediately to the original payment method upon customer notification without requiring merchant return fees.',
      },
    });
  }

  console.log('Seeding completed successfully in db_sentrix!');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
