interface Props {
  name: string;
  role: string;
}

export function MultiFileChild({ name, role }: Props) {
  return (
    <div className="multi-file-child">
      <span data-testid="child-name">{name}</span>
      <span data-testid="child-role">{role}</span>
    </div>
  );
}
