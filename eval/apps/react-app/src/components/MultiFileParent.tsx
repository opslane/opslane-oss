import { MultiFileChild } from './MultiFileChild';

interface Props {
  userName: string;
  userRole: string;
}

export function MultiFileParent({ userName, userRole }: Props) {
  return (
    <div className="multi-file-parent">
      <h1 data-testid="parent-title">User Info</h1>
      <MultiFileChild name={userName} role={userRole} />
    </div>
  );
}
