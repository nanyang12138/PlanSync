import { NextRequest } from 'next/server';
import { AppError, ErrorCode } from '@plansync/shared';
import { prisma } from './prisma';

export interface AuthContext {
  userName: string;
  projectRole?: 'owner' | 'developer';
}

export async function authenticate(req: NextRequest): Promise<AuthContext> {
  const authDisabled = process.env.AUTH_DISABLED === 'true';

  if (authDisabled) {
    const userName = req.headers.get('x-user-name') || 'anonymous';
    return { userName };
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  const secret = process.env.PLANSYNC_SECRET;

  if (token !== secret) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid token');
  }

  const userName = req.headers.get('x-user-name');
  if (!userName) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Missing X-User-Name header');
  }

  return { userName };
}

export async function requireProjectRole(
  auth: AuthContext,
  projectId: string,
  requiredRole?: 'owner',
): Promise<AuthContext> {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_name: { projectId, name: auth.userName } },
  });

  if (!member) {
    throw new AppError(ErrorCode.FORBIDDEN, `User "${auth.userName}" is not a member of this project`);
  }

  if (requiredRole === 'owner' && member.role !== 'owner') {
    throw new AppError(ErrorCode.FORBIDDEN, 'Only project owners can perform this action');
  }

  return { ...auth, projectRole: member.role as 'owner' | 'developer' };
}
