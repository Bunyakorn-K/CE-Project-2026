import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  component: TermsPage
});

const UPDATED = "25 กันยายน 2026";

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="grid gap-2"><h2>{title}</h2><div className="text-sm leading-relaxed text-muted">{children}</div></section>;
}

function TermsPage() {
  return (
    <main className="min-h-screen bg-background px-5 py-10 max-[639px]:px-4 max-[639px]:py-6">
      <article className="mx-auto w-full max-w-[820px] rounded-2xl border border-border bg-surface p-8 shadow-surface max-[639px]:p-5">
        <header className="grid gap-2 border-b border-border pb-5"><h1>ข้อกำหนดการใช้งาน (Terms of Use)</h1><p>LaundryTwin · อัปเดตล่าสุด: {UPDATED}</p></header>
        <div className="grid gap-6 pt-6">
          <Block title="บริการ"><p>LaundryTwin เป็นพื้นที่ปฏิบัติการสำหรับติดตามข้อมูลร้านซักผ้าหลายสาขา รายงานการใช้งาน และหลักฐานที่มีแหล่งที่มา ผู้ใช้ต้องเข้าสู่ระบบด้วยบัญชีที่ได้รับอนุญาต</p></Block>
          <Block title="บัญชีและการเข้าถึง"><p>ระบบบันทึกบทบาทและขอบเขตสาขาไว้เพื่อใช้ตรวจสอบสิทธิ์ การจำกัดข้อมูลและการซ่อนรายได้เป็นความรับผิดชอบของเซิร์ฟเวอร์ แต่การตรวจสอบขอบเขตและ revenue redaction ใน production ยังไม่ถือเป็นคำรับรองที่เสร็จสมบูรณ์</p></Block>
          <Block title="ข้อมูลและความสด"><p>ข้อมูลอาจมาจากระบบเดิมของร้าน, IRIS, ClickHouse, ETL หรือแหล่งอื่น และอาจล่าช้า ไม่ครบ หรือไม่พร้อมใช้งาน ผู้ใช้ควรตรวจสอบช่วงเวลา แหล่งที่มา และ freshness ที่แสดงในหน้าจอก่อนใช้ตัดสินใจปฏิบัติการ</p></Block>
          <Block title="ขอบเขตด้านความปลอดภัย"><p>ข้อมูลสถานะเครื่อง อุณหภูมิ แรงดัน และการประมาณการใด ๆ เป็นข้อมูลเพื่อการวิเคราะห์ ไม่ใช่ระบบเตือนภัยทางกายภาพ ไม่สามารถใช้แทนอุปกรณ์แจ้งเตือนในพื้นที่ทำงานหรือการตัดสินใจความปลอดภัยได้</p></Block>
          <Block title="การติดต่อ"><p>สอบถามเพิ่มเติม: <a className="inline-flex min-h-[44px] items-center font-medium text-accent underline-offset-4" href="mailto:noreply@laundrytwin.duckdns.org">noreply@laundrytwin.duckdns.org</a></p></Block>
        </div>
        <nav className="mt-5 flex flex-wrap items-center gap-2 text-xs text-muted" aria-label="การนำทางหน้ากฎหมาย"><Link to="/login" className="inline-flex min-h-[44px] items-center font-medium text-accent underline-offset-4">← กลับหน้าเข้าสู่ระบบ</Link><Link to="/privacy" className="inline-flex min-h-[44px] items-center font-medium text-accent underline-offset-4">อ่านนโยบายความเป็นส่วนตัว</Link></nav>
      </article>
    </main>
  );
}
