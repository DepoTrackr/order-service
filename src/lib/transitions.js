const ALLOWED_STATUSES = ["created", "approved", "rejected", "fulfilled"];

const STATUS_TRANSITIONS = {
  created: ["approved", "rejected"],
  approved: ["fulfilled"],
  rejected: [],
  fulfilled: [],
};

const canTransition = (from, to) => (STATUS_TRANSITIONS[from] || []).includes(to);

module.exports = { ALLOWED_STATUSES, STATUS_TRANSITIONS, canTransition };
