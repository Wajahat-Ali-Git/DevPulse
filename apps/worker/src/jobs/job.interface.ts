export interface JobData<T = any> {
  id: string;
  name: string;
  payload: T;
  createdAt: Date;
}

export interface JobResult<R = any> {
  jobId: string;
  success: boolean;
  data?: R;
  error?: string;
}
