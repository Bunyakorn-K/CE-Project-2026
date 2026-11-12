import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage
});

const UPDATED = "25 กันยายน 2026";

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="grid gap-2"><h2>{title}</h2><div className="text-sm leading-relaxed text-muted">{children}</div></section>;
}

function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background px-5 py-10 max-[639px]:px-4 max-[639px]:py-6">
      <article className="mx-auto w-full max-w-[820px] rounded-2xl border border-border bg-surface p-8 shadow-surface max-[639px]:p-5">
        <header className="grid gap-2 border-b border-border pb-5"><h1>นโยบายความเป็นส่วนตัว (Privacy Policy)</h1><p>LaundryTwin · อัปเดตล่าสุด: {UPDATED}</p></header>
        <div className="grid gap-6 pt-6">
          <Block title="ข้อมูลที่ระบบใช้"><p>ระบบใช้ข้อมูลบัญชีและตัวระบุผู้ใช้ที่จำเป็น เช่น ชื่อ อีเมล หรือ LINE user ID รวมถึงบทบาทและสิทธิ์สาขาที่บันทึกไว้ เพื่อให้ผู้ใช้เข้าถึงพื้นที่ที่ได้รับอนุญาต ระบบยังอ่านข้อมูลการใช้งานเครื่อง รายงาน และการแจ้งเตือนจากแหล่งที่องค์กรอนุญาตเพื่อแสดงหลักฐานและผลวิเคราะห์</p></Block>
          <Block title="วัตถุประสงค์"><p>ข้อมูลใช้แสดงสถานะ รายงาน และการแจ้งเตือนในบริบทของบัญชี การวิเคราะห์ด้วย AI ในแต่ละช่องทางอาจใช้ฟังก์ชันที่อนุญาตเท่านั้น และ AI Console ปัจจุบันเป็น plain chat ที่ยังไม่เรียก MCP tool จากหน้านี้</p><p>การควบคุมขอบเขตสาขาและการซ่อนรายได้เป็นกลไกฝั่งเซิร์ฟเวอร์ แต่ Direct ClickHouse report scope, revenue redaction และการยืนยัน LINE authentication ยังอยู่ระหว่างการตรวจสอบระดับ production จึงไม่ควรตีความว่าเป็นคำรับรองด้านการรักษาข้อมูลในทุกกรณี</p></Block>
          <Block title="การเก็บรักษาและความปลอดภัย"><p>นโยบายนี้ไม่ระบุระยะเวลาเก็บ log หรือการรับประกันการเข้ารหัสและการควบคุมการเข้าถึงทั้งหมด เพราะหลักฐานการตรวจสอบ production ยังไม่ครบ ผู้ดูแลระบบควรแจ้งรายละเอียดที่ตรวจสอบแล้วให้ผู้ใช้ทราบก่อนนำข้อมูลไปใช้งานจริง</p></Block>
          <Block title="สิทธิของผู้ใช้"><p>ผู้ใช้สามารถติดต่อผู้ดูแลระบบเพื่อขอแก้ไขหรือลบข้อมูลส่วนบุคคลตามกระบวนการที่องค์กรกำหนด การซ่อนข้อมูลสาขาที่ไม่มีสิทธิ์และการจำกัดรายได้ยังต้องผ่านการตรวจสอบระดับ production</p></Block>
          <Block title="การติดต่อ"><p>สอบถามเรื่องความเป็นส่วนตัว: <a className="inline-flex min-h-[44px] items-center font-medium text-accent underline-offset-4" href="mailto:noreply@laundrytwin.duckdns.org">noreply@laundrytwin.duckdns.org</a></p></Block>
        </div>
        <nav className="mt-5 flex flex-wrap items-center gap-2 text-xs text-muted" aria-label="การนำทางหน้ากฎหมาย"><Link to="/login" className="inline-flex min-h-[44px] items-center font-medium text-accent underline-offset-4">← กลับหน้าเข้าสู่ระบบ</Link><Link to="/terms" className="inline-flex min-h-[44px] items-center font-medium text-accent underline-offset-4">อ่านข้อกำหนดการใช้งาน</Link></nav>
      </article>
    </main>
  );
}
