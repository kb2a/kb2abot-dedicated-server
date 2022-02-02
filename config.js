export default {
	defaultPrefix: "/", // prefix mặc định cho mỗi box mới
	prettyDatastore: false, // enable may cause to its performance (adding \t character to datastore)
	superAdmins: [
		// 'super admin' có permission hơn cả admin, thường là những người điều khiển bot
		// Những người này có quyền được sử dụng 1 số lệnh nguy hiểm (như reload, update, ...)
		// Bạn có thể lên trang: findidfb.com hoặc lookup-id.com để lấy ID Facebook
		"100007723935647"
	],
	refreshAdminIDs: false,
	interval: {
		datastore: 1000*60*10
	}
}
