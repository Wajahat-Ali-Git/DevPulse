export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Repository {
  id: string;
  githubId: number;
  name: string;
  fullName: string;
  owner: string;
  url: string;
  defaultBranch: string;
}

export interface Metric {
  id: string;
  repositoryId: string;
  type: string;
  value: number;
  timestamp: Date;
}
