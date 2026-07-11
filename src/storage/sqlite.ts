import { DbHarness } from "../workers/db-harness";
import { Storage, GraphNode, GraphEdge, CodebaseIndexEntry, StalenessResult, AgentCommit, CommitSnapshot, CommitDiff, LearnedRule } from "./interface";
import { AgentAddress, Message, ParticipantRole, ThreadSummary } from "../types";

export class SqliteStorage implements Storage {
  private harness: DbHarness;
  constructor(path = "agentmailbox.db") {
    this.harness = new DbHarness(path);
  }
  async init(...args: any[]): Promise<any> { return this.harness.call("init", ...args); }
  async close(): Promise<void> { return this.harness.close(); }
  async registerAgent(...args: any[]): Promise<any> { return this.harness.call("registerAgent", ...args); }
  async getAgent(...args: any[]): Promise<any> { return this.harness.call("getAgent", ...args); }
  async createThread(...args: any[]): Promise<any> { return this.harness.call("createThread", ...args); }
  async getThread(...args: any[]): Promise<any> { return this.harness.call("getThread", ...args); }
  async getThreadByParticipants(...args: any[]): Promise<any> { return this.harness.call("getThreadByParticipants", ...args); }
  async getThreadByParticipantSet(...args: any[]): Promise<any> { return this.harness.call("getThreadByParticipantSet", ...args); }
  async getThreadParticipants(...args: any[]): Promise<any> { return this.harness.call("getThreadParticipants", ...args); }
  async appendMessage(...args: any[]): Promise<any> { return this.harness.call("appendMessage", ...args); }
  async getMessages(...args: any[]): Promise<any> { return this.harness.call("getMessages", ...args); }
  async getMailbox(...args: any[]): Promise<any> { return this.harness.call("getMailbox", ...args); }
  async markRead(...args: any[]): Promise<any> { return this.harness.call("markRead", ...args); }
  async getUnread(...args: any[]): Promise<any> { return this.harness.call("getUnread", ...args); }
  async getSummary(...args: any[]): Promise<any> { return this.harness.call("getSummary", ...args); }
  async saveSummary(...args: any[]): Promise<any> { return this.harness.call("saveSummary", ...args); }
  async upsertNode(...args: any[]): Promise<any> { return this.harness.call("upsertNode", ...args); }
  async deleteNode(...args: any[]): Promise<any> { return this.harness.call("deleteNode", ...args); }
  async addEdge(...args: any[]): Promise<any> { return this.harness.call("addEdge", ...args); }
  async deleteEdge(...args: any[]): Promise<any> { return this.harness.call("deleteEdge", ...args); }
  async queryGraph(...args: any[]): Promise<any> { return this.harness.call("queryGraph", ...args); }
  async upsertIndex(...args: any[]): Promise<any> { return this.harness.call("upsertIndex", ...args); }
  async getIndex(...args: any[]): Promise<any> { return this.harness.call("getIndex", ...args); }
  async searchIndex(...args: any[]): Promise<any> { return this.harness.call("searchIndex", ...args); }
  async deleteIndex(...args: any[]): Promise<any> { return this.harness.call("deleteIndex", ...args); }
  async checkStaleness(...args: any[]): Promise<any> { return this.harness.call("checkStaleness", ...args); }
  async rollupModule(...args: any[]): Promise<any> { return this.harness.call("rollupModule", ...args); }
  async createCommit(...args: any[]): Promise<any> { return this.harness.call("createCommit", ...args); }
  async deleteCommit(...args: any[]): Promise<any> { return this.harness.call("deleteCommit", ...args); }
  async listCommits(...args: any[]): Promise<any> { return this.harness.call("listCommits", ...args); }
  async getCommit(...args: any[]): Promise<any> { return this.harness.call("getCommit", ...args); }
  async restoreCommit(...args: any[]): Promise<any> { return this.harness.call("restoreCommit", ...args); }
  async diffCommits(...args: any[]): Promise<any> { return this.harness.call("diffCommits", ...args); }
  async mergeCommits(...args: any[]): Promise<any> { return this.harness.call("mergeCommits", ...args); }

  // Active Learning Rules
  async upsertLearnedRule(...args: any[]): Promise<any> { return this.harness.call("upsertLearnedRule", ...args); }
  async getLearnedRules(...args: any[]): Promise<any> { return this.harness.call("getLearnedRules", ...args); }
}
