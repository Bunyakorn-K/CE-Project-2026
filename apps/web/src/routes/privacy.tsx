import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage
});

const UPDATED = "25 กันยายน 2026";

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="legal-block"><h2>{title}</h2><div className="legal-copy">{children}</div></section>;
}

function PrivacyPage() {
  return (
    <main className="legal-page">
      <article className="legal-card">
        <header className="legal-header"><h1>นโยบายความเป็นส่วนตัว (Privacy Policy)</h1><p>LaundryTwin · อัปเดตล่าสุด: {UPDATED}</p></header>
        <div className="legal-sections">
          <Block title="ข้อมูลที่ระบบใช้"><p>ระบบใช้ข้อมูลบัญชีและตัวระบุผู้ใช้ที่จำเป็น เช่น ชื่อ อีเมล หรือ LINE user ID รวมถึงบทบาทและสิทธิ์สาขาที่บันทึกไว้ เพื่อให้ผู้ใช้เข้าถึงพื้นที่ที่ได้รับอนุญาต ระบบยังอ่านข้อมูลการใช้งานเครื่อง รายงาน และการแจ้งเตือนจากแหล่งที่องค์กรอนุญาตเพื่อแสดงหลักฐานและผลวิเคราะห์</p></Block>
          <Block title="วัตถุประสงค์"><p>ข้อมูลใช้แสดงสถานะ รายงาน และการแจ้งเตือนในบริบทของบัญชี การวิเคราะห์ด้วย AI ในแต่ละช่องทางอาจใช้ฟังก์ชันที่อนุญาตเท่านั้น และ AI Console ปัจจุบันเป็น plain chat ที่ยังไม่เรียก MCP tool จากหน้านี้</p><p>การควบคุมขอบเขตสาขาและการซ่อนรายได้เป็นกลไกฝั่งเซิร์ฟเวอร์ แต่ Direct ClickHouse report scope, revenue redaction และการยืนยัน LINE authentication ยังอยู่ระหว่างการตรวจสอบระดับ production จึงไม่ควรตีความว่าเป็นคำรับรองด้านการรักษาข้อมูลในทุกกรณี</p></Block>
          <Block title="การเก็บรักษาและความปลอดภัย"><p>นโยบายนี้ไม่ระบุระยะเวลาเก็บ log หรือการรับประกันการเข้ารหัสและการควบคุมการเข้าถึงทั้งหมด เพราะหลักฐานการตรวจสอบ production ยังไม่ครบ ผู้ดูแลระบบควรแจ้งรายละเอียดที่ตรวจสอบแล้วให้ผู้ใช้ทราบก่อนนำข้อมูลไปใช้งานจริง</p></Block>
          <Block title="สิทธิของผู้ใช้"><p>ผู้ใช้สามารถติดต่อผู้ดูแลระบบเพื่อขอแก้ไขหรือลบข้อมูลส่วนบุคคลตามกระบวนการที่องค์กรกำหนด การซ่อนข้อมูลสาขาที่ไม่มีสิทธิ์และการจำกัดรายได้ยังต้องผ่านการตรวจสอบระดับ production</p></Block>
          <Block title="การติดต่อ"><p>สอบถามเรื่องความเป็นส่วนตัว: <a className="legal-link" href="mailto:noreply@laundrytwin.duckdns.org">noreply@laundrytwin.duckdns.org</a></p></Block>
        </div>
        <nav className="legal-navigation" aria-label="การนำทางหน้ากฎหมาย"><Link to="/login" className="legal-link">← กลับหน้าเข้าสู่ระบบ</Link><Link to="/terms" className="legal-link">อ่านข้อกำหนดการใช้งาน</Link></nav>
      </article>
    </main>
  );
}
