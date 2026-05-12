import { Button } from '../components/Button';
import { fetchUsers } from '../lib/api';

export default async function Page() {
  const users = await fetchUsers();
  return <Button label={`hi ${users.length}`} />;
}
