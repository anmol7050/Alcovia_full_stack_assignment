import { Router, Request, Response } from 'express';

const router = Router();

// In-memory log of notifications received (for dev panel visibility)
const notificationLog: Array<{
  received_at: string;
  payload: any;
}> = [];

router.post('/', (req: Request, res: Response) => {
  const entry = {
    received_at: new Date().toISOString(),
    payload: req.body,
  };
  notificationLog.push(entry);

  const { streak, coins_earned, total_coins, session_id, target_minutes } = req.body;
  console.log(
    `[MOCK NOTIFY] 🎉 Session ${session_id} | Streak: ${streak} days | +${coins_earned} coins (total: ${total_coins}) | ${target_minutes} min focus`
  );

  return res.json({ ok: true, message: `Streak now ${streak} days, +${coins_earned} coins.` });
});

router.get('/log', (_req: Request, res: Response) => {
  return res.json(notificationLog);
});

router.delete('/log', (_req: Request, res: Response) => {
  notificationLog.length = 0;
  return res.json({ ok: true });
});

export default router;
