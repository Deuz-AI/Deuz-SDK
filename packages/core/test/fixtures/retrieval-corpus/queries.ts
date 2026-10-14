/**
 * The 50 labelled queries of the offline retrieval corpus (2.4, spec §5.2),
 * two per topic. Some reuse the record's words, others paraphrase it, so the
 * numbers separate lexical from dense matching. `relevant` lists every
 * record that answers the query.
 */

export interface RetrievalQuery {
  id: string;
  text: string;
  relevant: readonly string[];
}

export const RETRIEVAL_QUERIES: readonly RetrievalQuery[] = [
  {
    id: 'q01',
    text: 'How many paid vacation days do I get each year?',
    relevant: ['pto-1', 'pto-5'],
  },
  { id: 'q02', text: 'Do leftover holiday days expire?', relevant: ['pto-2'] },
  { id: 'q03', text: 'When do I have to submit an expense report?', relevant: ['expense-1'] },
  {
    id: 'q04',
    text: 'What is the daily meal allowance on a business trip?',
    relevant: ['expense-3', 'travel-7'],
  },
  { id: 'q05', text: 'How many days a week can I work from home?', relevant: ['remote-1'] },
  {
    id: 'q06',
    text: 'Is there money for setting up a home office?',
    relevant: ['remote-3', 'remote-6'],
  },
  { id: 'q07', text: 'What are the password length rules?', relevant: ['passwords-1'] },
  { id: 'q08', text: 'Where should I keep my work credentials?', relevant: ['passwords-3'] },
  { id: 'q09', text: 'How do I get VPN access?', relevant: ['vpn-2'] },
  { id: 'q10', text: 'The VPN will not connect, what should I try?', relevant: ['vpn-6'] },
  { id: 'q11', text: 'What counts as a severity one incident?', relevant: ['incident-1'] },
  {
    id: 'q12',
    text: 'When is a postmortem written after an outage?',
    relevant: ['incident-3', 'incident-7'],
  },
  { id: 'q13', text: 'Can we deploy to production on a Friday evening?', relevant: ['deploy-2'] },
  { id: 'q14', text: 'How does the canary rollout work?', relevant: ['deploy-4', 'deploy-5'] },
  { id: 'q15', text: 'How many approvals does a pull request need?', relevant: ['review-1'] },
  {
    id: 'q16',
    text: 'My change is very large, what should I do before review?',
    relevant: ['review-3'],
  },
  { id: 'q17', text: 'How long is an on-call shift?', relevant: ['oncall-2'] },
  { id: 'q18', text: 'Is on-call work paid extra?', relevant: ['oncall-3'] },
  { id: 'q19', text: 'How often are database backups taken?', relevant: ['backups-1'] },
  {
    id: 'q20',
    text: 'How long do we keep database backups?',
    relevant: ['backups-2', 'backups-3'],
  },
  {
    id: 'q21',
    text: 'What is the API request limit on the standard plan?',
    relevant: ['ratelimit-1'],
  },
  {
    id: 'q22',
    text: 'What happens when a client sends too many requests?',
    relevant: ['ratelimit-3', 'ratelimit-4'],
  },
  { id: 'q23', text: 'When are invoices sent out?', relevant: ['billing-1'] },
  {
    id: 'q24',
    text: 'What happens if an invoice is not paid?',
    relevant: ['billing-6', 'billing-7'],
  },
  {
    id: 'q25',
    text: 'Can I get my money back after buying?',
    relevant: ['refunds-1', 'refunds-8'],
  },
  { id: 'q26', text: 'Who can approve a large refund?', relevant: ['refunds-5', 'refunds-6'] },
  {
    id: 'q27',
    text: 'How long does standard shipping take within Turkey?',
    relevant: ['shipping-1'],
  },
  { id: 'q28', text: 'When is delivery free?', relevant: ['shipping-3'] },
  {
    id: 'q29',
    text: 'What are customer support opening hours?',
    relevant: ['support-1', 'support-5'],
  },
  { id: 'q30', text: 'Which languages does live chat offer?', relevant: ['support-3'] },
  {
    id: 'q31',
    text: 'What happens on my first day as a new hire?',
    relevant: ['onboarding-1', 'onboarding-7'],
  },
  { id: 'q32', text: 'How long is probation for new employees?', relevant: ['onboarding-6'] },
  { id: 'q33', text: 'Which laptops can engineers pick?', relevant: ['hardware-1'] },
  { id: 'q34', text: 'My laptop was stolen, who do I tell?', relevant: ['hardware-4'] },
  { id: 'q35', text: 'What are the opening hours of the Ankara office?', relevant: ['office-1'] },
  { id: 'q36', text: 'Is food provided in the office?', relevant: ['office-4'] },
  {
    id: 'q37',
    text: 'How do I book a flight for a business trip?',
    relevant: ['travel-1', 'travel-2'],
  },
  { id: 'q38', text: 'How much can a hotel night cost?', relevant: ['travel-3'] },
  { id: 'q39', text: 'How fast do we handle a GDPR erasure request?', relevant: ['retention-3'] },
  {
    id: 'q40',
    text: 'When is customer data deleted after an account closes?',
    relevant: ['retention-1'],
  },
  { id: 'q41', text: 'How much does the Team plan cost?', relevant: ['pricing-2'] },
  { id: 'q42', text: 'Is there a free trial before paying?', relevant: ['pricing-7'] },
  { id: 'q43', text: 'How often are new mobile app versions released?', relevant: ['mobile-1'] },
  { id: 'q44', text: 'Which Android versions does the app support?', relevant: ['mobile-5'] },
  { id: 'q45', text: 'How often do analytics dashboards refresh?', relevant: ['analytics-1'] },
  {
    id: 'q46',
    text: 'How do I request a new dashboard?',
    relevant: ['analytics-3', 'analytics-8'],
  },
  { id: 'q47', text: 'How many interviews does a candidate have?', relevant: ['hiring-1'] },
  { id: 'q48', text: 'Is there a bonus for referring a friend?', relevant: ['hiring-4'] },
  { id: 'q49', text: 'When do performance reviews take place?', relevant: ['perf-1'] },
  { id: 'q50', text: 'How are promotions decided?', relevant: ['perf-3'] },
];
